"""
Linear issue creation for processing failures.

Creates issues in Linear when dataset processing fails, with full context
including dataset info, error message, user email, and recent logs.
"""

import requests
from typing import Optional
from supabase import create_client
from shared.settings import settings
from shared.db import use_client
from shared.logging import LogContext, LogCategory, UnifiedLogger, SupabaseHandler
from shared.models import TaskTypeEnum

# Initialize logger with database persistence
logger = UnifiedLogger(__name__)
logger.add_supabase_handler(SupabaseHandler())


# Linear API configuration
LINEAR_API_URL = 'https://api.linear.app/graphql'
LINEAR_BUG_LABEL_ID = '3cd77898-47b3-488e-8509-e51da0cba52f'
LINEAR_TRIAGE_STATE_ID = 'b4b9bac3-5698-4f17-b7f5-52818b031af1'
LINEAR_PRIORITY_HIGH = 1


def get_stage_display_name(stage: str) -> str:
	"""Get display name for a processing stage using TaskTypeEnum."""
	task_type = TaskTypeEnum.from_string(stage)
	if task_type:
		return task_type.display_name
	# Fallback for legacy stage names
	legacy_mapping = {
		'deadwood_segmentation': 'Deadwood',
		'treecover_segmentation': 'Tree Cover',
		'processing': 'Processing',
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


def check_existing_issue(dataset_id: int) -> bool:
	"""Check if a Linear issue already exists for this dataset."""
	if not settings.LINEAR_API_KEY:
		return False

	query = '''
	query SearchIssues($query: String!) {
		issueSearch(query: $query, first: 1) {
			nodes {
				id
				identifier
			}
		}
	}
	'''

	try:
		response = requests.post(
			LINEAR_API_URL,
			headers={
				'Authorization': settings.LINEAR_API_KEY,
				'Content-Type': 'application/json',
			},
			json={
				'query': query,
				'variables': {'query': f'[Processing Failure] Dataset ID: {dataset_id}'},
			},
			timeout=10,
		)

		if response.status_code == 200:
			data = response.json()
			nodes = data.get('data', {}).get('issueSearch', {}).get('nodes', [])
			if nodes:
				logger.info(f'Found existing Linear issue for dataset {dataset_id}: {nodes[0].get("identifier")}')
				return True

		return False
	except Exception as e:
		logger.warning(f'Failed to check for existing Linear issue: {e}')
		return False


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

	return f'''## Processing Failure

{metadata_section}

## Error Message
```
{error_message}
```
{logs_section}
'''


def create_processing_failure_issue(
	token: str,
	dataset_id: int,
	stage: str,
	error_message: str,
) -> Optional[str]:
	"""
	Create a Linear issue for a processing failure.

	Args:
		token: Supabase auth token for database queries
		dataset_id: The dataset that failed
		stage: The processing stage that failed (e.g., 'cog', 'odm_processing')
		error_message: The error message

	Returns:
		The Linear issue identifier (e.g., 'DT-123') if created, None otherwise
	"""
	# Check if Linear integration is enabled
	if not settings.LINEAR_ENABLED:
		logger.debug('Linear integration disabled, skipping issue creation')
		return None

	if not settings.LINEAR_API_KEY:
		logger.warning('LINEAR_API_KEY not set, skipping issue creation')
		return None

	try:
		# Log the attempt
		logger.info(
			f'Attempting to create Linear issue for dataset {dataset_id} (stage: {stage})',
			LogContext(category=LogCategory.STATUS, dataset_id=dataset_id, token=token),
		)

		# Check for existing issue (duplicate detection by dataset_id)
		if check_existing_issue(dataset_id):
			logger.info(
				f'Skipping issue creation - issue already exists for dataset {dataset_id}',
				LogContext(category=LogCategory.STATUS, dataset_id=dataset_id, token=token),
			)
			return None

		# Get dataset context (includes file info, user, ortho metadata)
		context = get_dataset_context(token, dataset_id)
		file_name = context.get('file_name', f'Dataset {dataset_id}')

		# Get recent error logs
		logs = get_recent_error_logs(token, dataset_id)

		# Build issue title and description
		stage_display = get_stage_display_name(stage)
		title = f'[Processing Failure] {file_name} - {stage_display} failed (Dataset ID: {dataset_id})'
		description = build_issue_description(
			dataset_id=dataset_id,
			stage=stage,
			error_message=error_message,
			context=context,
			logs=logs,
		)

		# Create issue via Linear GraphQL API
		mutation = '''
		mutation CreateIssue($input: IssueCreateInput!) {
			issueCreate(input: $input) {
				success
				issue {
					id
					identifier
					url
				}
			}
		}
		'''

		response = requests.post(
			LINEAR_API_URL,
			headers={
				'Authorization': settings.LINEAR_API_KEY,
				'Content-Type': 'application/json',
			},
			json={
				'query': mutation,
				'variables': {
					'input': {
						'teamId': settings.LINEAR_TEAM_ID,
						'title': title,
						'description': description,
						'priority': LINEAR_PRIORITY_HIGH,
						'stateId': LINEAR_TRIAGE_STATE_ID,
						'labelIds': [LINEAR_BUG_LABEL_ID],
					}
				},
			},
			timeout=15,
		)

		if response.status_code == 200:
			data = response.json()
			issue_data = data.get('data', {}).get('issueCreate', {})

			if issue_data.get('success'):
				issue = issue_data.get('issue', {})
				identifier = issue.get('identifier', 'Unknown')
				url = issue.get('url', '')
				logger.info(
					f'Created Linear issue {identifier} for dataset {dataset_id}: {url}',
					LogContext(category=LogCategory.STATUS, dataset_id=dataset_id, token=token),
				)
				return identifier
			else:
				errors = data.get('errors', [])
				logger.error(
					f'Linear issue creation failed: {errors}',
					LogContext(category=LogCategory.STATUS, dataset_id=dataset_id, token=token),
				)
				return None
		else:
			logger.error(
				f'Linear API request failed with status {response.status_code}: {response.text}',
				LogContext(category=LogCategory.STATUS, dataset_id=dataset_id, token=token),
			)
			return None

	except Exception as e:
		# Fail gracefully - never block processing
		logger.error(
			f'Failed to create Linear issue for dataset {dataset_id}: {e}',
			LogContext(category=LogCategory.STATUS, dataset_id=dataset_id, token=token),
		)
		return None
