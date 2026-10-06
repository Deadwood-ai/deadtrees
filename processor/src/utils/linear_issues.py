"""
Linear reporting for processing failures.

Each failure becomes a comment on one open cluster issue per pipeline stage,
with full context including dataset info, error message, user email, and
recent logs.
"""

import re
import requests
from typing import Optional
from supabase import create_client
from shared.settings import settings
from shared.db import use_client
from shared.logging import LogContext, LogCategory, UnifiedLogger, SupabaseHandler
from shared.models import TaskTypeEnum
from shared.redaction import redact_tokens

# Initialize logger with database persistence
logger = UnifiedLogger(__name__)
logger.add_supabase_handler(SupabaseHandler())


# Linear API configuration
LINEAR_API_URL = 'https://api.linear.app/graphql'
LINEAR_BUG_LABEL_ID = '3cd77898-47b3-488e-8509-e51da0cba52f'
LINEAR_TRIAGE_STATE_ID = 'b4b9bac3-5698-4f17-b7f5-52818b031af1'
LINEAR_PRIORITY_MEDIUM = 3
CLOSED_STATE_TYPES = {'completed', 'canceled'}

# Failure stages arrive under several names (ProcessingError task types, queue task
# types, crash-detection stage names). Each maps to the crash-detection name in
# processor.PIPELINE_STAGE_MAP, so one stage has one fingerprint. The Factory read
# model (factory_failure_stage in SQL) applies the same mapping.
STAGE_KEY_ALIASES = {
	'odm': 'odm_processing',
	'geotiff': 'ortho_processing',
	'geotiff_dependency': 'ortho_processing',
	'convert': 'ortho_processing',
	'metadata': 'metadata_processing',
	'cog': 'cog_processing',
	'thumbnail': 'thumbnail_processing',
	'deadwood': 'deadwood_segmentation',
	'deadwood_v1': 'deadwood_segmentation',
	'treecover': 'forest_cover_segmentation',
	'treecover_v1': 'forest_cover_segmentation',
	'treecover_segmentation': 'forest_cover_segmentation',
	'deadwood_treecover_combined_v2': 'deadwood_treecover_combined_segmentation',
	'aoi_v1': 'aoi_segmentation',
	'embeddings_v1': 'embedding_processing',
	'doy_estimation_v1': 'doy_estimation',
	'georef_check_v1': 'georef_check',
	'processing': 'unknown',
}


def get_stage_display_name(stage: str) -> str:
	"""Get display name for a processing stage using TaskTypeEnum."""
	task_type = TaskTypeEnum.from_string(stage)
	if task_type:
		return task_type.display_name
	# Fallback for legacy stage names
	legacy_mapping = {
		'deadwood_segmentation': 'Deadwood',
		'treecover_segmentation': 'Tree Cover',
		'deadwood_treecover_combined_segmentation': 'Combined Deadwood+Treecover',
		'forest_cover_segmentation': 'Tree Cover',
		'ortho_processing': 'GeoTIFF',
		'metadata_processing': 'Metadata',
		'cog_processing': 'COG',
		'thumbnail_processing': 'Thumbnail',
		'aoi_segmentation': 'AOI',
		'embedding_processing': 'Embeddings',
		'doy_estimation': 'Acquisition date',
		'georef_check': 'Georeferencing check',
		'processing': 'Processing',
		'unknown': 'Unknown stage',
	}
	return legacy_mapping.get(stage, stage)


def get_dataset_context(token: str, dataset_id: int) -> dict:
	"""
	Get dataset context including file info, user, and ortho metadata.
	
	Returns dict with optional keys - all fields are safe to access with .get():
	- file_name: Dataset filename
	- user_email: Uploader's email
	- storage_path: Full path on storage server
	- ortho_file_name: Ortho filename from v2_orthos
	- ortho_file_size_mb: File size in MB
	- ortho_crs: Coordinate reference system
	- ortho_dimensions: Width x Height in pixels
	- ortho_bands: Number of bands
	- created_at: Dataset creation timestamp
	"""
	context = {'file_name': f'Dataset {dataset_id}'}
	
	try:
		with use_client(token) as client:
			# Get dataset info
			response = client.table(settings.datasets_table).select(
				'file_name, user_id, created_at'
			).eq('id', dataset_id).execute()

			if response.data:
				dataset = response.data[0]
				context['file_name'] = dataset.get('file_name', f'Dataset {dataset_id}')
				context['created_at'] = dataset.get('created_at')
				user_id = dataset.get('user_id')

				# Get user email using service role client's admin auth API
				if user_id and settings.SUPABASE_SERVICE_ROLE_KEY:
					try:
						service_client = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)
						user = service_client.auth.admin.get_user_by_id(str(user_id))
						if user and user.user and user.user.email:
							context['user_email'] = user.user.email
					except Exception as e:
						logger.debug(f'Failed to get user email for {user_id}: {e}')

			# Get ortho metadata from v2_orthos
			try:
				ortho_response = client.table(settings.orthos_table).select(
					'ortho_file_name, ortho_file_size, ortho_info'
				).eq('dataset_id', dataset_id).execute()

				if ortho_response.data:
					ortho = ortho_response.data[0]
					ortho_file_name = ortho.get('ortho_file_name')
					
					if ortho_file_name:
						context['ortho_file_name'] = ortho_file_name
						# Build storage path
						storage_base = getattr(settings, 'STORAGE_SERVER_DATA_PATH', '/data')
						context['storage_path'] = f'{storage_base}/{settings.ARCHIVE_DIR}/{ortho_file_name}'
					
					# File size in MB (stored as MB in database)
					file_size = ortho.get('ortho_file_size')
					if file_size:
						context['ortho_file_size_mb'] = file_size
					
					# Extract info from ortho_info JSONB
					ortho_info = ortho.get('ortho_info') or {}
					if isinstance(ortho_info, dict):
						# CRS
						crs = ortho_info.get('CRS')
						if crs:
							context['ortho_crs'] = crs
						
						# Dimensions
						size = ortho_info.get('Size')
						if size and isinstance(size, list) and len(size) >= 2:
							context['ortho_dimensions'] = f'{size[0]} x {size[1]}'
						
						# Bands
						band_count = ortho_info.get('Band Count')
						if band_count:
							context['ortho_bands'] = band_count
			except Exception:
				pass  # Ortho metadata is optional

	except Exception as e:
		logger.warning(f'Failed to get dataset context for {dataset_id}: {e}')
	
	return context


def get_recent_error_logs(token: str, dataset_id: int, limit: int = 10) -> list[str]:
	"""Get recent error logs for a dataset."""
	try:
		with use_client(token) as client:
			response = client.table(settings.logs_table).select(
				'level, message, created_at'
			).eq('dataset_id', dataset_id).in_(
				'level', ['ERROR', 'CRITICAL']
			).order('created_at', desc=True).limit(limit).execute()

			if not response.data:
				return []

			logs = []
			for log in response.data:
				timestamp = log.get('created_at', '')[:19]  # Truncate to seconds
				level = log.get('level', 'ERROR')
				message = log.get('message', '')
				logs.append(f'[{timestamp}] {level}: {message}')

			return logs
	except Exception as e:
		logger.warning(f'Failed to get error logs for dataset {dataset_id}: {e}')
		return []


def stage_key(stage: str | None) -> str:
	"""The one canonical name of a failure stage (see STAGE_KEY_ALIASES)."""
	key = (stage or '').strip()
	return STAGE_KEY_ALIASES.get(key, key) or 'unknown'


def failure_fingerprint(stage: str | None) -> str:
	"""The fingerprint naming the Linear cluster issue for failures in one pipeline stage."""
	return f'processor/failure/{stage_key(stage)}'


def _linear_request(query: str, variables: dict, timeout: int = 15) -> dict:
	response = requests.post(
		LINEAR_API_URL,
		headers={'Authorization': settings.LINEAR_API_KEY, 'Content-Type': 'application/json'},
		json={'query': query, 'variables': variables},
		timeout=timeout,
	)
	if response.status_code != 200:
		raise RuntimeError(f'Linear API request failed with status {response.status_code}: {response.text}')
	data = response.json()
	if data.get('errors'):
		raise RuntimeError(f'Linear API returned errors: {data["errors"]}')
	return data.get('data') or {}


def find_open_cluster_issue(fingerprint: str) -> Optional[dict]:
	"""Return the open issue whose description carries exactly this fingerprint line."""
	query = '''
	query SearchIssues($term: String!) {
		searchIssues(term: $term, first: 25) {
			nodes { id identifier description state { type } }
		}
	}
	'''
	# Linear's editor re-serializes edited descriptions and escapes underscores.
	pattern = re.escape(fingerprint).replace('_', r'\\?_')
	line = re.compile(rf'^fingerprint:\s*{pattern}\s*$', re.MULTILINE)
	nodes = _linear_request(query, {'term': fingerprint}, timeout=10).get('searchIssues', {}).get('nodes', [])
	for issue in nodes:
		if (issue.get('state') or {}).get('type') in CLOSED_STATE_TYPES:
			continue
		if line.search(issue.get('description') or ''):
			return issue
	return None


def create_cluster_issue(stage: str) -> dict:
	"""Open the cluster issue that collects every failure in one canonical stage."""
	fingerprint = failure_fingerprint(stage)
	mutation = '''
	mutation CreateIssue($input: IssueCreateInput!) {
		issueCreate(input: $input) { success issue { id identifier url } }
	}
	'''
	description = (
		f'Cluster issue for processing failures in the {get_stage_display_name(stage)} stage. '
		'The processor comments each new failure here. Group known causes as child issues.\n\n'
		'The Factory attention list links here by this fingerprint.\n\n'
		f'fingerprint: {fingerprint}'
	)
	data = _linear_request(
		mutation,
		{
			'input': {
				'teamId': settings.LINEAR_TEAM_ID,
				'title': f'Processing failures: {get_stage_display_name(stage)}',
				'description': description,
				'priority': LINEAR_PRIORITY_MEDIUM,
				'stateId': LINEAR_TRIAGE_STATE_ID,
				'labelIds': [LINEAR_BUG_LABEL_ID],
			}
		},
	)
	result = data.get('issueCreate') or {}
	if not result.get('success'):
		raise RuntimeError('Linear did not create the cluster issue')
	return result['issue']


def comment_on_issue(issue_id: str, body: str) -> None:
	mutation = '''
	mutation CreateComment($input: CommentCreateInput!) {
		commentCreate(input: $input) { success }
	}
	'''
	data = _linear_request(mutation, {'input': {'issueId': issue_id, 'body': body}})
	if not (data.get('commentCreate') or {}).get('success'):
		raise RuntimeError('Linear did not create the comment')


def build_issue_description(
	dataset_id: int,
	stage: str,
	error_message: str,
	context: dict,
	logs: list[str],
) -> str:
	"""
	Build the issue description markdown.
	
	Uses context dict with optional fields - gracefully handles missing data.
	"""
	stage_display = get_stage_display_name(stage)

	# Build metadata lines - only include fields that exist
	metadata_lines = [
		f'**Dataset ID:** {dataset_id}',
		f'**File Name:** {context.get("file_name", "Unknown")}',
		f'**Failed Stage:** {stage_display}',
	]
	
	# Optional fields - only add if present
	if context.get('user_email'):
		metadata_lines.append(f'**User:** {context["user_email"]}')
	
	if context.get('storage_path'):
		metadata_lines.append(f'**Storage Path:** `{context["storage_path"]}`')
	
	if context.get('created_at'):
		# Format timestamp nicely
		created = context['created_at'][:19] if context['created_at'] else None
		if created:
			metadata_lines.append(f'**Created:** {created}')
	
	# Ortho metadata section
	ortho_info_parts = []
	if context.get('ortho_file_size_mb'):
		size_mb = context['ortho_file_size_mb']
		if size_mb >= 1024:
			ortho_info_parts.append(f'{size_mb / 1024:.1f} GB')
		else:
			ortho_info_parts.append(f'{size_mb} MB')
	
	if context.get('ortho_dimensions'):
		ortho_info_parts.append(context['ortho_dimensions'])
	
	if context.get('ortho_bands'):
		ortho_info_parts.append(f'{context["ortho_bands"]} bands')
	
	if context.get('ortho_crs'):
		ortho_info_parts.append(context['ortho_crs'])
	
	if ortho_info_parts:
		metadata_lines.append(f'**Ortho Info:** {" | ".join(ortho_info_parts)}')
	
	metadata_section = '\n'.join(metadata_lines)

	logs_section = ''
	if logs:
		logs_section = '\n## Recent Logs\n```\n' + '\n'.join(logs) + '\n```'

	return redact_tokens(f'''## Processing Failure

{metadata_section}

## Error Message
```
{error_message}
```
{logs_section}
''')


def report_processing_failure(
	token: str,
	dataset_id: int,
	stage: str,
	error_message: str,
) -> Optional[str]:
	"""
	Record a processing failure on the open Linear cluster issue for its stage.

	One issue collects every failure in a stage, found by its fingerprint line, and
	each failure is a comment on it. A new cluster issue is opened at Medium priority
	in Triage only when no open one exists. Never raises: Linear must not block
	processing.

	Returns the cluster issue identifier (e.g., 'DT-123'), or None when nothing was posted.
	"""
	if not settings.LINEAR_ENABLED:
		logger.debug('Linear integration disabled, skipping failure report')
		return None

	if not settings.LINEAR_API_KEY:
		logger.warning('LINEAR_API_KEY not set, skipping failure report')
		return None

	fingerprint = failure_fingerprint(stage)
	try:
		issue = find_open_cluster_issue(fingerprint) or create_cluster_issue(stage_key(stage))
		body = build_issue_description(
			dataset_id=dataset_id,
			stage=stage,
			error_message=error_message,
			context=get_dataset_context(token, dataset_id),
			logs=get_recent_error_logs(token, dataset_id),
		)
		comment_on_issue(issue['id'], body)
		logger.info(
			f'Reported dataset {dataset_id} failure on Linear {issue.get("identifier")} ({fingerprint})',
			LogContext(category=LogCategory.STATUS, dataset_id=dataset_id, token=token),
		)
		return issue.get('identifier')
	except Exception as e:
		logger.error(
			f'Failed to report dataset {dataset_id} failure to Linear: {e}',
			LogContext(category=LogCategory.STATUS, dataset_id=dataset_id, token=token),
		)
		return None
