import asyncio
from typing import Callable, Optional, List
from enum import Enum, auto
import tempfile
from pathlib import Path
import time
import shutil
import zipfile
import io

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, Response, Query
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel
import pandas as pd

from shared.__version__ import __version__
from shared.models import Dataset, Label
from shared.settings import settings
from api.src.download.downloads import (
	bundle_dataset,
	bundle_multi_dataset,
	get_bundle_filename,
	get_all_dataset_labels,
	label_to_geopackage,
	create_citation_file,
	create_consolidated_geopackage,
	generate_bundle_job_id,
)
from shared.db import use_client
from shared.logger import logger

# first approach to implement a rate limit
CONNECTED_IPS = {}

# create the router for download
download_app = FastAPI(
	title='Deadwood-AI Download API',
	description='This is the Deadwood-AI Download API. It is used to download single files and full Datasets. This is part of the Deadwood API.',
	version=__version__,
)

# add cors
download_app.add_middleware(
	CORSMiddleware,
	allow_origins=['*'],
	allow_credentials=False,
	allow_methods=['OPTIONS', 'GET'],
	allow_headers=['Content-Type', 'Accept', 'Accept-Encoding'],
)


# add the middleware for rate limiting
@download_app.middleware('http')
async def rate_limiting(request: Request, call_next: Callable[[Request], Response]):
	# get the ip
	ip = request.client.host

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


# add the format model
class MetadataFormat(str, Enum):
	json = 'json'
	csv = 'csv'


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


async def get_public_dataset(dataset_id: str) -> tuple[Dataset, dict]:
	"""Get dataset and ortho data, but only if it's publicly accessible"""
	with use_client() as client:
		# Get dataset
		dataset_response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()

		if not dataset_response.data:
			raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> not found.')

		dataset = Dataset(**dataset_response.data[0])

		# Only allow access to public datasets
		if dataset.data_access.value == 'private':
			raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> not found.')

		# Get ortho data
		ortho_response = client.table(settings.orthos_table).select('*').eq('dataset_id', dataset_id).execute()
		ortho = ortho_response.data[0] if ortho_response.data else None

		return dataset, ortho


# Updated download route with background processing
@download_app.get('/datasets/{dataset_id}/dataset.zip', response_model=DownloadStatus)
async def download_dataset(
	dataset_id: str,
	background_tasks: BackgroundTasks,
	include_labels: bool = Query(True),
	include_parquet: bool = Query(True),
	use_original_filename: bool = Query(False),
):
	"""
	Prepare dataset bundle in the background and return job status
	"""
	# Check dataset exists and is public
	dataset, ortho = await get_public_dataset(dataset_id)

	if not ortho:
		raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> has no ortho file.')

	# Build the file paths
	download_dir = settings.downloads_path / dataset_id
	download_file = download_dir / get_bundle_filename(int(dataset_id), include_labels, include_parquet)

	# Check if file already exists
	if download_file.exists():
		if download_file.stat().st_size > 0:
			# File already exists, return completed status (not the direct URL)
			return DownloadStatus(
				status=DownloadStatusEnum.COMPLETED,
				job_id=dataset_id,
				message='Dataset bundle is ready for download',
				download_path=f'/downloads/v1/{dataset_id}/{download_file.name}',
			)
		# Zero-byte file -> remove and rebuild
		download_file.unlink()

	# Create download directory if it doesn't exist
	download_dir.mkdir(parents=True, exist_ok=True)

	# Start background task to create the archive
	background_tasks.add_task(
		create_dataset_bundle_background,
		dataset_id=dataset_id,
		dataset=dataset,
		ortho=ortho,
		include_labels=include_labels,
		include_parquet=include_parquet,
		use_original_filename=use_original_filename,
	)

	# Return processing status response
	return DownloadStatus(
		status=DownloadStatusEnum.PROCESSING, job_id=dataset_id, message='Dataset bundle is being prepared'
	)


@download_app.get('/datasets/{dataset_id}/status', response_model=DownloadStatus)
async def check_download_status(
	dataset_id: str,
	include_labels: bool = Query(True),
	include_parquet: bool = Query(True),
):
	"""Check the status of a dataset bundle job"""
	download_dir = settings.downloads_path / dataset_id
	download_file = download_dir / get_bundle_filename(int(dataset_id), include_labels, include_parquet)

	# Check dataset exists and is public
	dataset, ortho = await get_public_dataset(dataset_id)

	if download_file.exists() and download_file.stat().st_size > 0:
		return DownloadStatus(
			status=DownloadStatusEnum.COMPLETED,
			job_id=dataset_id,
			message='Dataset bundle is ready for download',
			download_path=f'/downloads/v1/{dataset_id}/{download_file.name}',
		)
	else:
		return DownloadStatus(
			status=DownloadStatusEnum.PROCESSING, job_id=dataset_id, message='Dataset bundle is being prepared'
		)


@download_app.get('/datasets/{dataset_id}/download', response_class=RedirectResponse)
async def download_dataset_file(
	dataset_id: str,
	include_labels: bool = Query(True),
	include_parquet: bool = Query(True),
):
	"""Redirect to the actual download file once it's ready"""
	# Check dataset exists and is public
	dataset, ortho = await get_public_dataset(dataset_id)

	download_file = settings.downloads_path / dataset_id / get_bundle_filename(int(dataset_id), include_labels, include_parquet)

	if not download_file.exists() or download_file.stat().st_size == 0:
		raise HTTPException(status_code=404, detail=f'Download file for dataset <ID={dataset_id}> not found')

	return RedirectResponse(url=f'/downloads/v1/{dataset_id}/{download_file.name}', status_code=303)


def create_dataset_bundle_background(
	dataset_id: str,
	dataset: Dataset,
	ortho: dict,
	include_labels: bool = True,
	include_parquet: bool = True,
	use_original_filename: bool = False,
):
	"""Background task to create dataset bundle"""
	download_dir = settings.downloads_path / dataset_id
	download_file = download_dir / get_bundle_filename(int(dataset_id), include_labels, include_parquet)

	try:
		# Build the file paths
		archive_file_name = (settings.archive_path / ortho['ortho_file_name']).resolve()

		# Bundle dataset directly to downloads directory - no need to pass label anymore
		bundle_dataset(
			str(download_file),
			archive_file_name,
			dataset=dataset,
			include_parquet=include_parquet,
			include_labels=include_labels,
			use_original_filename=use_original_filename,
		)

		logger.info(f'Dataset bundle completed for dataset {dataset_id}')

	except Exception as e:
		logger.error(f'Error in background dataset bundling: {str(e)}', extra={'dataset_id': dataset_id})
		# Remove failed file if it exists
		if download_file.exists():
			download_file.unlink()


def create_labels_geopackage_background(dataset_id: str):
	"""Background task to create labels geopackage"""
	download_dir = settings.downloads_path / dataset_id
	labels_file = download_dir / f'{dataset_id}_labels.gpkg'

	try:
		logger.info(f'Starting labels GeoPackage creation for dataset {dataset_id}')

		# Create consolidated geopackage in temp directory
		temp_gpkg = create_consolidated_geopackage(int(dataset_id))

		# Move to downloads directory
		shutil.move(str(temp_gpkg), str(labels_file))

		# Clean up temp directory
		shutil.rmtree(temp_gpkg.parent)

		logger.info(f'Labels GeoPackage completed for dataset {dataset_id}')

	except ValueError as e:
		logger.error(f'No labels found for dataset {dataset_id}: {str(e)}')
		# Remove failed file if it exists
		if labels_file.exists():
			labels_file.unlink()
	except Exception as e:
		logger.error(f'Error in background labels GeoPackage creation: {str(e)}', extra={'dataset_id': dataset_id})
		# Remove failed file if it exists
		if labels_file.exists():
			labels_file.unlink()


# @download_app.get('/datasets/{dataset_id}/ortho.tif')
# async def download_geotiff(dataset_id: str):
# 	"""
# 	Download the original GeoTiff of the dataset with the given ID.
# 	"""
# 	# load the dataset
# 	dataset = Dataset.by_id(dataset_id)

# 	if dataset is None:
# 		raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> not found.')

# 	# here we can add the monitoring
# 	# monitoring.download_ortho.inc()

# 	# build the file name
# 	path = settings.archive_path / dataset.file_name

# 	return FileResponse(path, media_type='image/tiff', filename=dataset.file_name)


# @download_app.get('/datasets/{dataset_id}/metadata.{file_format}')
# async def get_metadata(dataset_id: str, file_format: MetadataFormat, background_tasks: BackgroundTasks):
# 	"""
# 	Download the metadata of the dataset with the given ID.
# 	"""
# 	# load the metadata
# 	metadata = Metadata.by_id(dataset_id)
# 	if metadata is None:
# 		raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> has no Metadata entry.')

# 	# switch the format
# 	if file_format == MetadataFormat.json:
# 		return metadata.model_dump_json()
# 	elif file_format == MetadataFormat.csv:
# 		# build a DataFrame
# 		df = pd.DataFrame.from_records([metadata.model_dump()])

# 		# create a temporary file
# 		target = tempfile.NamedTemporaryFile(suffix='.csv', delete_on_close=False)
# 		df.to_csv(target.name, index=False)

# 		# add a background task to remove the file after download
# 		background_tasks.add_task(lambda: Path(target.name).unlink())

# 		return FileResponse(target.name, media_type='text/csv', filename='metadata.csv')


@download_app.get('/datasets/{dataset_id}/labels.gpkg', response_model=DownloadStatus)
async def get_labels(dataset_id: str, background_tasks: BackgroundTasks):
	"""
	Prepare labels GeoPackage in the background and return job status
	"""
	try:
		# Check dataset exists and is public
		dataset, ortho = await get_public_dataset(dataset_id)

		# Build the file paths
		download_dir = settings.downloads_path / dataset_id
		labels_file = download_dir / f'{dataset_id}_labels.gpkg'

		# Check if file already exists
		if labels_file.exists():
			# File already exists, return completed status
			return DownloadStatus(
				status=DownloadStatusEnum.COMPLETED,
				job_id=f'labels_{dataset_id}',
				message='Labels GeoPackage is ready for download',
				download_path=f'/downloads/v1/{dataset_id}/{dataset_id}_labels.gpkg',
			)

		# Create download directory if it doesn't exist
		download_dir.mkdir(parents=True, exist_ok=True)

		# Start background task to create the geopackage
		background_tasks.add_task(create_labels_geopackage_background, dataset_id=dataset_id)

		# Return processing status response
		return DownloadStatus(
			status=DownloadStatusEnum.PROCESSING,
			job_id=f'labels_{dataset_id}',
			message='Labels GeoPackage is being prepared',
		)
	except Exception as e:
		logger.error(f'Error initiating labels download for dataset {dataset_id}: {str(e)}')
		raise HTTPException(status_code=500, detail=f'Error initiating labels download: {str(e)}')


@download_app.get('/datasets/{dataset_id}/labels/status', response_model=DownloadStatus)
async def check_labels_status(dataset_id: str):
	"""Check the status of a labels GeoPackage job"""
	download_dir = settings.downloads_path / dataset_id
	labels_file = download_dir / f'{dataset_id}_labels.gpkg'

	# Check dataset exists and is public
	dataset, ortho = await get_public_dataset(dataset_id)

	if labels_file.exists():
		return DownloadStatus(
			status=DownloadStatusEnum.COMPLETED,
			job_id=f'labels_{dataset_id}',
			message='Labels GeoPackage is ready for download',
			download_path=f'/downloads/v1/{dataset_id}/{dataset_id}_labels.gpkg',
		)
	else:
		return DownloadStatus(
			status=DownloadStatusEnum.PROCESSING,
			job_id=f'labels_{dataset_id}',
			message='Labels GeoPackage is being prepared',
		)


@download_app.get('/datasets/{dataset_id}/labels/download', response_class=RedirectResponse)
async def download_labels_file(dataset_id: str):
	"""Redirect to the actual labels download file once it's ready"""
	# Check dataset exists and is public
	dataset, ortho = await get_public_dataset(dataset_id)

	labels_file = settings.downloads_path / dataset_id / f'{dataset_id}_labels.gpkg'

	if not labels_file.exists():
		raise HTTPException(status_code=404, detail=f'Labels file for dataset <ID={dataset_id}> not found')

	return RedirectResponse(url=f'/downloads/v1/{dataset_id}/{dataset_id}_labels.gpkg', status_code=303)


# =============================================================================
# Multi-Dataset Bundle Endpoints
# =============================================================================


async def get_datasets_for_bundle(dataset_ids: List[int]) -> List[tuple]:
	"""
	Fetch dataset, ortho, and metadata for multiple datasets.
	Only returns public datasets.
	
	Returns:
		List of tuples: (dataset, ortho_dict, metadata_dict, archive_file_path)
	"""
	results = []
	
	with use_client() as client:
		for dataset_id in dataset_ids:
			# Get dataset
			dataset_response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()
			
			if not dataset_response.data:
				raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> not found.')
			
			dataset = Dataset(**dataset_response.data[0])
			
			# Only allow access to public datasets
			if dataset.data_access.value == 'private':
				raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> not found.')
			
			# Get ortho data
			ortho_response = client.table(settings.orthos_table).select('*').eq('dataset_id', dataset_id).execute()
			
			if not ortho_response.data:
				raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> has no ortho file.')
			
			ortho = ortho_response.data[0]
			
			# Get metadata
			metadata_response = client.table(settings.metadata_table).select('*').eq('dataset_id', dataset_id).execute()
			metadata = metadata_response.data[0] if metadata_response.data else None
			
			# Build archive file path
			archive_file_path = str((settings.archive_path / ortho['ortho_file_name']).resolve())
			
			results.append((dataset, ortho, metadata, archive_file_path))
	
	return results


def create_multi_bundle_background(
	job_id: str,
	datasets_info: List[tuple],
	include_labels: bool = False,
	include_parquet: bool = False,
	use_original_filename: bool = True,
):
	"""Background task to create multi-dataset bundle"""
	download_dir = settings.downloads_path / 'bundles'
	download_file = download_dir / f'{job_id}.zip'
	
	try:
		bundle_multi_dataset(
			str(download_file),
			datasets_info,
			include_labels=include_labels,
			include_parquet=include_parquet,
			use_original_filename=use_original_filename,
		)
		logger.info(f'Multi-dataset bundle completed: {job_id}')
		
	except Exception as e:
		logger.error(f'Error in background multi-dataset bundling: {str(e)}', extra={'job_id': job_id})
		# Remove failed file if it exists
		if download_file.exists():
			download_file.unlink()


@download_app.get('/bundle.zip', response_model=DownloadStatus)
async def prepare_multi_bundle(
	background_tasks: BackgroundTasks,
	dataset_ids: str = Query(..., description="Comma-separated dataset IDs (e.g., '123,456,789')"),
	include_labels: bool = Query(False, description="Include label GeoPackages"),
	include_parquet: bool = Query(False, description="Include METADATA.parquet"),
	use_original_filename: bool = Query(True, description="Use original filenames for orthos"),
):
	"""
	Prepare a multi-dataset bundle in the background and return job status.
	
	This endpoint creates a single ZIP containing:
	- All ortho files (with collision handling)
	- Consolidated METADATA.csv (one row per dataset)
	- METADATA.parquet (optional)
	- Label GeoPackages (optional, always use dataset ID in filename)
	- LICENSE.txt
	- CITATION.cff
	"""
	# Parse and validate dataset IDs
	try:
		id_list = [int(x.strip()) for x in dataset_ids.split(',') if x.strip()]
	except ValueError:
		raise HTTPException(status_code=400, detail="Invalid dataset_ids format. Use comma-separated integers.")
	
	if not id_list:
		raise HTTPException(status_code=400, detail="At least one dataset ID is required.")
	
	if len(id_list) > 100:
		raise HTTPException(status_code=400, detail="Maximum 100 datasets per bundle.")
	
	# Generate job ID
	job_id = generate_bundle_job_id(id_list, include_labels, include_parquet)
	
	# Check if bundle already exists
	download_dir = settings.downloads_path / 'bundles'
	download_file = download_dir / f'{job_id}.zip'
	
	if download_file.exists() and download_file.stat().st_size > 0:
		return DownloadStatus(
			status=DownloadStatusEnum.COMPLETED,
			job_id=job_id,
			message=f'Bundle with {len(id_list)} datasets is ready for download',
			download_path=f'/downloads/v1/bundles/{job_id}.zip',
		)
	
	# Create download directory if it doesn't exist
	download_dir.mkdir(parents=True, exist_ok=True)
	
	# Remove any existing zero-byte file
	if download_file.exists():
		download_file.unlink()
	
	# Fetch all datasets (validates they exist and are public)
	datasets_info = await get_datasets_for_bundle(id_list)
	
	# Start background task
	background_tasks.add_task(
		create_multi_bundle_background,
		job_id=job_id,
		datasets_info=datasets_info,
		include_labels=include_labels,
		include_parquet=include_parquet,
		use_original_filename=use_original_filename,
	)
	
	return DownloadStatus(
		status=DownloadStatusEnum.PROCESSING,
		job_id=job_id,
		message=f'Bundle with {len(id_list)} datasets is being prepared',
	)


@download_app.get('/bundle/status', response_model=DownloadStatus)
async def check_bundle_status(
	job_id: str = Query(..., description="The job ID returned from /bundle.zip"),
):
	"""Check the status of a multi-dataset bundle job"""
	download_file = settings.downloads_path / 'bundles' / f'{job_id}.zip'
	
	if download_file.exists() and download_file.stat().st_size > 0:
		return DownloadStatus(
			status=DownloadStatusEnum.COMPLETED,
			job_id=job_id,
			message='Bundle is ready for download',
			download_path=f'/downloads/v1/bundles/{job_id}.zip',
		)
	else:
		return DownloadStatus(
			status=DownloadStatusEnum.PROCESSING,
			job_id=job_id,
			message='Bundle is being prepared',
		)


@download_app.get('/bundle/download', response_class=RedirectResponse)
async def download_bundle_file(
	job_id: str = Query(..., description="The job ID returned from /bundle.zip"),
):
	"""Redirect to the actual bundle download file once it's ready"""
	download_file = settings.downloads_path / 'bundles' / f'{job_id}.zip'
	
	if not download_file.exists() or download_file.stat().st_size == 0:
		raise HTTPException(status_code=404, detail=f'Bundle <job_id={job_id}> not found or not ready')
	
	return RedirectResponse(url=f'/downloads/v1/bundles/{job_id}.zip', status_code=303)
