import re
from functools import partial
from typing import Callable, Optional, List, Annotated
from enum import Enum
from pathlib import Path
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, Response, Query, Depends
from fastapi.responses import RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel

from shared.__version__ import __version__
from shared.models import Dataset
from api.src.utils.request_ip import get_client_ip
from shared.settings import settings
from api.src.download.downloads import (
	ExportScope,
	bundle_dataset,
	bundle_multi_dataset,
	create_consolidated_geopackage,
	read_export_scope,
)
from api.src.download.jobs import JobState, JobStatus, PreparedFileJob
from api.src.download.keys import (
	content_version,
	generate_bundle_job_id,
	get_bundle_filename,
	get_labels_filename,
	labels_content_version,
	prepared_job,
)
from shared.db import use_client, use_service_client, verify_token
from shared.logging import UnifiedLogger, SupabaseHandler, LogCategory, LogContext

# first approach to implement a rate limit
CONNECTED_IPS = {}
DOWNLOAD_REQUESTS_PER_DAY = 100
BUNDLE_JOB_ID = re.compile(r'[0-9a-f]{28}')  # 16-hex variant + 12-hex content version
oauth2_scheme = OAuth2PasswordBearer(tokenUrl='token')

# create the router for download
download_app = FastAPI(
	title='Deadwood-AI Download API',
	description='This is the Deadwood-AI Download API. It is used to download single files and full Datasets. This is part of the Deadwood API.',
	version=__version__,
)
logger = UnifiedLogger(__name__)
logger.add_supabase_handler(SupabaseHandler())

# add cors
download_app.add_middleware(
	CORSMiddleware,
	allow_origins=['*'],
	allow_credentials=False,
	allow_methods=['OPTIONS', 'GET'],
	allow_headers=['Content-Type', 'Accept', 'Accept-Encoding', 'Authorization'],
)


# add the middleware for rate limiting
@download_app.middleware('http')
async def rate_limiting(request: Request, call_next: Callable[[Request], Response]):
	# get the ip (behind host nginx, the peer is the proxy; see get_client_ip)
	ip = get_client_ip(request) or 'unknown'

	# check if the IP is currently downloading
	if ip in CONNECTED_IPS:
		raise HTTPException(status_code=429, detail='Rate limit exceeded. You can only download one file at a time.')

	# set the ip
	CONNECTED_IPS[ip] = True

	# do the response
	try:
		response = await call_next(request)
		return response
	finally:
		# in any case delete the ip again
		if ip in CONNECTED_IPS:
			del CONNECTED_IPS[ip]


# add the gzip middleware
download_app.add_middleware(GZipMiddleware)


@download_app.get('/')
def info():
	pass


# Define models for download status
class DownloadStatusEnum(str, Enum):
	PENDING = 'pending'
	PROCESSING = 'processing'
	COMPLETED = 'completed'
	FAILED = 'failed'


class DownloadStatus(BaseModel):
	"""Model for download job status responses"""

	status: DownloadStatusEnum
	job_id: str
	message: str = ''
	download_path: str = ''


def parse_dataset_id(dataset_id: str) -> int:
	"""Parse dataset IDs from route params and return a clean 400 on invalid values."""
	try:
		return int(dataset_id)
	except (TypeError, ValueError):
		raise HTTPException(status_code=400, detail=f'Invalid dataset ID: {dataset_id}')


def enforce_dataset_download_access(
	dataset: Dataset,
	allow_viewonly_full_download: bool,
):
	"""Enforce dataset-level access policy for download endpoints."""
	if not allow_viewonly_full_download and dataset.data_access.value == 'viewonly':
		raise HTTPException(
			status_code=403,
			detail='This dataset is view-only. Please download predictions (GPKG) instead.',
		)


async def get_accessible_dataset(
	dataset_id: int,
	token: str,
	allow_viewonly_full_download: bool = True,
) -> tuple[Dataset, dict]:
	"""Get dataset and ortho data if the requesting user is allowed to access it."""
	with use_client(token) as client:
		dataset_response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()
		if not dataset_response.data:
			raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> not found.')

		dataset = Dataset(**dataset_response.data[0])
		enforce_dataset_download_access(
			dataset=dataset,
			allow_viewonly_full_download=allow_viewonly_full_download,
		)

		ortho_response = client.table(settings.orthos_table).select('*').eq('dataset_id', dataset_id).execute()
		ortho = ortho_response.data[0] if ortho_response.data else None
		return dataset, ortho


def validate_user_and_limit(
	token: str,
	endpoint: str,
	dataset_id: Optional[int] = None,
	job_id: Optional[str] = None,
	count_towards_limit: bool = True,
):
	"""Validate auth token and enforce per-user daily download request limits."""
	user = verify_token(token)
	if not user:
		raise HTTPException(status_code=401, detail='Invalid token')

	requests_last_day = 0
	if count_towards_limit:
		window_start = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
		with use_client(token) as client:
			usage_response = (
				client.table(settings.logs_table)
				.select('id', count='exact')
				.eq('user_id', user.id)
				.eq('category', LogCategory.DOWNLOAD.value)
				.contains('extra', {'count_towards_limit': True, 'event': 'allowed'})
				.gte('created_at', window_start)
				.execute()
			)
			requests_last_day = usage_response.count or 0

		if requests_last_day >= DOWNLOAD_REQUESTS_PER_DAY:
			logger.warning(
				f'Download rate limit exceeded for user {user.id}',
				context=LogContext(
					category=LogCategory.DOWNLOAD,
					user_id=user.id,
					dataset_id=dataset_id,
					token=token,
					extra={
						'event': 'blocked',
						'endpoint': endpoint,
						'job_id': job_id,
						'requests_last_day': requests_last_day,
						'limit_per_day': DOWNLOAD_REQUESTS_PER_DAY,
						'count_towards_limit': True,
					},
				),
			)
			raise HTTPException(status_code=429, detail='Daily download limit exceeded (100/day). Please try again tomorrow.')

	logger.info(
		'Download endpoint access granted',
		context=LogContext(
			category=LogCategory.DOWNLOAD,
			user_id=user.id,
			dataset_id=dataset_id,
			token=token,
			extra={
				'event': 'allowed',
				'endpoint': endpoint,
				'job_id': job_id,
				'count_towards_limit': count_towards_limit,
			},
		),
	)

	return user


def record_download_request(user_id, dataset_ids: List[int], kind: str) -> None:
	"""Record one accepted download request for Factory reuse metrics. Never blocks the download.

	A bundle is one request with one row per distinct dataset, sharing a request ID.
	"""
	request_id = str(uuid.uuid4())
	try:
		with use_service_client() as client:
			client.table('dataset_download_requests').insert(
				[
					{'dataset_id': dataset_id, 'user_id': str(user_id), 'kind': kind, 'request_id': request_id}
					for dataset_id in dict.fromkeys(dataset_ids)
				]
			).execute()
	except Exception as e:
		logger.warning(f'Could not record download request for datasets {dataset_ids}: {e}')



# =============================================================================
# Prepared-file jobs: every route below is a thin wrapper around PreparedFileJob
# =============================================================================


def _status_response(job: PreparedFileJob, job_id: str, noun: str, status: Optional[JobStatus] = None) -> DownloadStatus:
	status = status or job.status()
	if status.state == JobState.COMPLETED:
		return DownloadStatus(
			status=DownloadStatusEnum.COMPLETED,
			job_id=job_id,
			message=f'{noun} is ready for download',
			download_path=job.download_path,
		)
	if status.state == JobState.PROCESSING:
		return DownloadStatus(status=DownloadStatusEnum.PROCESSING, job_id=job_id, message=f'{noun} is being prepared')
	# A missing job was never started, expired, or belongs to content that has since changed.
	message = status.message or f'{noun} is not being prepared. Please request the download again.'
	return DownloadStatus(status=DownloadStatusEnum.FAILED, job_id=job_id, message=message)


def _start_job(
	job: PreparedFileJob,
	background_tasks: BackgroundTasks,
	build: Callable[[Path], object],
	job_id: str,
	noun: str,
) -> DownloadStatus:
	"""Return a finished file, join a live build, or claim and schedule a new build."""
	if job.status().state != JobState.COMPLETED and job.claim():
		background_tasks.add_task(job.run, build)
		return _status_response(job, job_id, noun, JobStatus(JobState.PROCESSING))
	return _status_response(job, job_id, noun)


def _redirect_to_file(job: PreparedFileJob, not_found_detail: str) -> RedirectResponse:
	status = job.status()
	if status.state == JobState.COMPLETED:
		return RedirectResponse(url=job.download_path, status_code=303)
	if status.state == JobState.FAILED:
		raise HTTPException(status_code=500, detail=status.message)
	raise HTTPException(status_code=404, detail=not_found_detail)


# =============================================================================
# Single-dataset bundle
# =============================================================================


async def _dataset_bundle_job(
	dataset_id: int,
	token: str,
	include_labels: bool,
	include_parquet: bool,
	use_original_filename: bool,
) -> tuple[PreparedFileJob, Dataset, Optional[dict], Optional[dict], Optional[ExportScope]]:
	"""Check access and name the bundle after its variant and the content the user may read."""
	dataset, ortho = await get_accessible_dataset(
		dataset_id=dataset_id,
		token=token,
		allow_viewonly_full_download=False,
	)
	with use_client(token) as client:
		metadata_response = client.table(settings.metadata_table).select('*').eq('dataset_id', dataset_id).execute()
		labels = read_export_scope(client, dataset_id) if include_labels else None
	metadata = metadata_response.data[0] if metadata_response.data else None

	version = content_version([(dataset, ortho, metadata, labels)], token)
	filename = get_bundle_filename(dataset_id, include_labels, include_parquet, use_original_filename, version)
	job = prepared_job(settings.downloads_path / str(dataset_id) / filename)
	return job, dataset, ortho, metadata, labels


@download_app.get('/datasets/{dataset_id}/dataset.zip', response_model=DownloadStatus)
async def download_dataset(
	dataset_id: str,
	background_tasks: BackgroundTasks,
	include_labels: bool = Query(True),
	include_parquet: bool = Query(True),
	use_original_filename: bool = Query(False),
	token: Annotated[str, Depends(oauth2_scheme)] = '',
):
	"""
	Prepare dataset bundle in the background and return job status
	"""
	dataset_id_int = parse_dataset_id(dataset_id)
	user = validate_user_and_limit(
		token=token,
		endpoint='datasets/{dataset_id}/dataset.zip',
		dataset_id=dataset_id_int,
	)
	job, dataset, ortho, metadata, labels = await _dataset_bundle_job(
		dataset_id_int, token, include_labels, include_parquet, use_original_filename
	)
	if not ortho:
		raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id_int}> has no ortho file.')
	record_download_request(user.id, [dataset_id_int], 'dataset')

	def build(target: Path):
		archive_file = (settings.archive_path / ortho['ortho_file_name']).resolve()
		bundle_dataset(
			str(target),
			archive_file,
			dataset=dataset,
			ortho=ortho,
			metadata=metadata,
			include_parquet=include_parquet,
			labels=labels,
			use_original_filename=use_original_filename,
		)

	return _start_job(job, background_tasks, build, str(dataset_id_int), 'Dataset bundle')


@download_app.get('/datasets/{dataset_id}/status', response_model=DownloadStatus)
async def check_download_status(
	dataset_id: str,
	include_labels: bool = Query(True),
	include_parquet: bool = Query(True),
	use_original_filename: bool = Query(False),
	token: Annotated[str, Depends(oauth2_scheme)] = '',
):
	"""Check the status of a dataset bundle job"""
	dataset_id_int = parse_dataset_id(dataset_id)
	validate_user_and_limit(
		token=token,
		endpoint='datasets/{dataset_id}/status',
		dataset_id=dataset_id_int,
		count_towards_limit=False,
	)
	job, *_ = await _dataset_bundle_job(dataset_id_int, token, include_labels, include_parquet, use_original_filename)
	return _status_response(job, str(dataset_id_int), 'Dataset bundle')


@download_app.get('/datasets/{dataset_id}/download', response_class=RedirectResponse)
async def download_dataset_file(
	dataset_id: str,
	include_labels: bool = Query(True),
	include_parquet: bool = Query(True),
	use_original_filename: bool = Query(False),
	token: Annotated[str, Depends(oauth2_scheme)] = '',
):
	"""Redirect to the actual download file once it's ready"""
	dataset_id_int = parse_dataset_id(dataset_id)
	validate_user_and_limit(
		token=token,
		endpoint='datasets/{dataset_id}/download',
		dataset_id=dataset_id_int,
	)
	job, *_ = await _dataset_bundle_job(dataset_id_int, token, include_labels, include_parquet, use_original_filename)
	return _redirect_to_file(job, f'Download file for dataset <ID={dataset_id_int}> not found')


# =============================================================================
# Labels GeoPackage
# =============================================================================


async def _labels_job(dataset_id: int, token: str) -> tuple[PreparedFileJob, ExportScope]:
	await get_accessible_dataset(dataset_id=dataset_id, token=token, allow_viewonly_full_download=True)
	with use_client(token) as client:
		scope = read_export_scope(client, dataset_id)
	filename = get_labels_filename(dataset_id, labels_content_version(scope, token))
	return prepared_job(settings.downloads_path / str(dataset_id) / filename), scope


@download_app.get('/datasets/{dataset_id}/labels.gpkg', response_model=DownloadStatus)
async def get_labels(
	dataset_id: str,
	background_tasks: BackgroundTasks,
	token: Annotated[str, Depends(oauth2_scheme)] = '',
):
	"""
	Prepare labels GeoPackage in the background and return job status
	"""
	dataset_id_int = parse_dataset_id(dataset_id)
	user = validate_user_and_limit(
		token=token,
		endpoint='datasets/{dataset_id}/labels.gpkg',
		dataset_id=dataset_id_int,
	)
	job, scope = await _labels_job(dataset_id_int, token)
	record_download_request(user.id, [dataset_id_int], 'labels')
	build = partial(create_consolidated_geopackage, dataset_id_int, scope)
	return _start_job(job, background_tasks, build, f'labels_{dataset_id_int}', 'Labels GeoPackage')


@download_app.get('/datasets/{dataset_id}/labels/status', response_model=DownloadStatus)
async def check_labels_status(
	dataset_id: str,
	token: Annotated[str, Depends(oauth2_scheme)] = '',
):
	"""Check the status of a labels GeoPackage job"""
	dataset_id_int = parse_dataset_id(dataset_id)
	validate_user_and_limit(
		token=token,
		endpoint='datasets/{dataset_id}/labels/status',
		dataset_id=dataset_id_int,
		count_towards_limit=False,
	)
	job, _ = await _labels_job(dataset_id_int, token)
	return _status_response(job, f'labels_{dataset_id_int}', 'Labels GeoPackage')


@download_app.get('/datasets/{dataset_id}/labels/download', response_class=RedirectResponse)
async def download_labels_file(
	dataset_id: str,
	token: Annotated[str, Depends(oauth2_scheme)] = '',
):
	"""Redirect to the actual labels download file once it's ready"""
	dataset_id_int = parse_dataset_id(dataset_id)
	validate_user_and_limit(
		token=token,
		endpoint='datasets/{dataset_id}/labels/download',
		dataset_id=dataset_id_int,
	)
	job, _ = await _labels_job(dataset_id_int, token)
	return _redirect_to_file(job, f'Labels file for dataset <ID={dataset_id_int}> not found')


# =============================================================================
# Multi-Dataset Bundle Endpoints
# =============================================================================


async def get_datasets_for_bundle(
	dataset_ids: List[int],
	token: str,
) -> List[tuple]:
	"""
	Fetch dataset, ortho, and metadata for multiple datasets.
	Enforces private/view-only download policy for the requesting user.

	Returns:
		List of tuples: (dataset, ortho_dict, metadata_dict, archive_file_path)
	"""
	results = []
	viewonly_dataset_ids: List[int] = []

	with use_client(token) as client:
		for dataset_id in dataset_ids:
			dataset_response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()
			if not dataset_response.data:
				raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> not found.')

			dataset = Dataset(**dataset_response.data[0])
			if dataset.data_access.value == 'viewonly':
				viewonly_dataset_ids.append(dataset_id)
				continue

			ortho_response = client.table(settings.orthos_table).select('*').eq('dataset_id', dataset_id).execute()
			if not ortho_response.data:
				raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> has no ortho file.')
			ortho = ortho_response.data[0]

			metadata_response = client.table(settings.metadata_table).select('*').eq('dataset_id', dataset_id).execute()
			metadata = metadata_response.data[0] if metadata_response.data else None

			archive_file_path = str((settings.archive_path / ortho['ortho_file_name']).resolve())
			results.append((dataset, ortho, metadata, archive_file_path))

	if viewonly_dataset_ids:
		blocked_ids = ', '.join(str(x) for x in sorted(viewonly_dataset_ids))
		raise HTTPException(
			status_code=403,
			detail=f'Bundle contains view-only datasets that cannot include orthophoto downloads: [{blocked_ids}]',
		)

	return results


def _bundle_job(job_id: str) -> PreparedFileJob:
	if not BUNDLE_JOB_ID.fullmatch(job_id):
		raise HTTPException(status_code=400, detail='Invalid bundle job ID.')
	return prepared_job(settings.downloads_path / 'bundles' / f'{job_id}.zip')


@download_app.get('/bundle.zip', response_model=DownloadStatus)
async def prepare_multi_bundle(
	background_tasks: BackgroundTasks,
	dataset_ids: str = Query(..., description="Comma-separated dataset IDs (e.g., '123,456,789')"),
	include_labels: bool = Query(False, description="Include label GeoPackages"),
	include_parquet: bool = Query(False, description="Include METADATA.parquet"),
	use_original_filename: bool = Query(True, description="Use original filenames for orthos"),
	token: Annotated[str, Depends(oauth2_scheme)] = '',
):
	"""
	Prepare a multi-dataset bundle in the background and return job status.

	This endpoint creates a single ZIP containing:
	- All ortho files (with collision handling)
	- Consolidated METADATA.csv (one row per dataset, including its license)
	- METADATA.parquet (optional)
	- Label GeoPackages (optional, always use dataset ID in filename)
	- LICENSE.txt (every license in the bundle and the datasets it covers)
	- CITATION.cff
	"""
	try:
		id_list = [int(x.strip()) for x in dataset_ids.split(',') if x.strip()]
	except ValueError:
		raise HTTPException(status_code=400, detail="Invalid dataset_ids format. Use comma-separated integers.")
	id_list = list(dict.fromkeys(id_list))

	if not id_list:
		raise HTTPException(status_code=400, detail="At least one dataset ID is required.")

	if len(id_list) > 100:
		raise HTTPException(status_code=400, detail="Maximum 100 datasets per bundle.")

	user = validate_user_and_limit(token=token, endpoint='bundle.zip')

	# Enforce per-dataset access and output checks for every request, including a
	# cached bundle another user prepared, before recording or returning it.
	datasets_info = await get_datasets_for_bundle(dataset_ids=id_list, token=token)
	label_scopes = None
	if include_labels:
		with use_client(token) as client:
			label_scopes = {dataset.id: read_export_scope(client, dataset.id) for dataset, *_ in datasets_info}
	version = content_version(
		[(dataset, ortho, metadata, label_scopes[dataset.id] if label_scopes is not None else None) for dataset, ortho, metadata, _ in datasets_info],
		token,
	)
	job_id = generate_bundle_job_id(id_list, include_labels, include_parquet, use_original_filename, version)
	record_download_request(user.id, id_list, 'bundle')

	build = partial(
		bundle_multi_dataset,
		datasets_info=datasets_info,
		label_scopes=label_scopes,
		include_parquet=include_parquet,
		use_original_filename=use_original_filename,
	)
	return _start_job(_bundle_job(job_id), background_tasks, build, job_id, f'Bundle with {len(id_list)} datasets')


@download_app.get('/bundle/status', response_model=DownloadStatus)
async def check_bundle_status(
	job_id: str = Query(..., description="The job ID returned from /bundle.zip"),
	token: Annotated[str, Depends(oauth2_scheme)] = '',
):
	"""Check the status of a multi-dataset bundle job"""
	validate_user_and_limit(
		token=token,
		endpoint='bundle/status',
		job_id=job_id,
		count_towards_limit=False,
	)
	return _status_response(_bundle_job(job_id), job_id, 'Bundle')


@download_app.get('/bundle/download', response_class=RedirectResponse)
async def download_bundle_file(
	job_id: str = Query(..., description="The job ID returned from /bundle.zip"),
	token: Annotated[str, Depends(oauth2_scheme)] = '',
):
	"""Redirect to the actual bundle download file once it's ready"""
	validate_user_and_limit(
		token=token,
		endpoint='bundle/download',
		job_id=job_id,
	)
	return _redirect_to_file(_bundle_job(job_id), f'Bundle <job_id={job_id}> not found or not ready')
