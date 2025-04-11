import asyncio
from typing import Callable
from enum import Enum, auto
import tempfile
from pathlib import Path
import time
import shutil
import zipfile
import io

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel
import pandas as pd

from shared.__version__ import __version__
from shared.models import Dataset, Label
from shared.settings import settings
from api.src.download.downloads import bundle_dataset, label_to_geopackage, create_citation_file
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
	except Exception as e:
		raise HTTPException(status_code=500, detail=str(e))
	finally:
		# in any case delete the ip again
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


# Updated download route with background processing
@download_app.get('/datasets/{dataset_id}/dataset.zip', response_model=DownloadStatus)
async def download_dataset(dataset_id: str, background_tasks: BackgroundTasks):
	"""
	Prepare dataset bundle in the background and return job status
	"""
	# Load the dataset using direct database query
	with use_client() as client:
		dataset_response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()
		if not dataset_response.data:
			raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> not found.')
		dataset = Dataset(**dataset_response.data[0])

		# Get the ortho file information
		ortho_response = client.table(settings.orthos_table).select('*').eq('dataset_id', dataset_id).execute()
		if not ortho_response.data:
			raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> has no ortho file.')
		ortho = ortho_response.data[0]

	# Build the file paths
	download_dir = settings.downloads_path / dataset_id
	download_file = download_dir / f'{dataset_id}.zip'

	# Check if file already exists
	if download_file.exists():
		# File already exists, return completed status (not the direct URL)
		return DownloadStatus(
			status=DownloadStatusEnum.COMPLETED,
			job_id=dataset_id,
			message='Dataset bundle is ready for download',
			download_path=f'/downloads/v1/{dataset_id}/{dataset_id}.zip',
		)

	# Create download directory if it doesn't exist
	download_dir.mkdir(parents=True, exist_ok=True)

	# Start background task to create the archive
	background_tasks.add_task(create_dataset_bundle_background, dataset_id=dataset_id, dataset=dataset, ortho=ortho)

	# Return processing status response
	return DownloadStatus(
		status=DownloadStatusEnum.PROCESSING, job_id=dataset_id, message='Dataset bundle is being prepared'
	)


@download_app.get('/datasets/{dataset_id}/status', response_model=DownloadStatus)
async def check_download_status(dataset_id: str):
	"""Check the status of a dataset bundle job"""
	download_dir = settings.downloads_path / dataset_id
	download_file = download_dir / f'{dataset_id}.zip'

	# Load the dataset to verify it exists
	with use_client() as client:
		dataset_response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()
		if not dataset_response.data:
			raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> not found.')

	if download_file.exists():
		return DownloadStatus(
			status=DownloadStatusEnum.COMPLETED,
			job_id=dataset_id,
			message='Dataset bundle is ready for download',
			download_path=f'/downloads/v1/{dataset_id}/{dataset_id}.zip',
		)
	else:
		return DownloadStatus(
			status=DownloadStatusEnum.PROCESSING, job_id=dataset_id, message='Dataset bundle is being prepared'
		)


@download_app.get('/datasets/{dataset_id}/download', response_class=RedirectResponse)
async def download_dataset_file(dataset_id: str):
	"""Redirect to the actual download file once it's ready"""
	download_file = settings.downloads_path / dataset_id / f'{dataset_id}.zip'

	if not download_file.exists():
		raise HTTPException(status_code=404, detail=f'Download file for dataset <ID={dataset_id}> not found')

	return RedirectResponse(url=f'/downloads/v1/{dataset_id}/{dataset_id}.zip', status_code=303)


async def create_dataset_bundle_background(dataset_id: str, dataset: Dataset, ortho: dict):
	"""Background task to create dataset bundle"""
	try:
		# Build the file paths
		archive_file_name = (settings.archive_path / ortho['ortho_file_name']).resolve()
		download_dir = settings.downloads_path / dataset_id
		download_file = download_dir / f'{dataset_id}.zip'

		# Bundle dataset directly to downloads directory - no need to pass label anymore
		bundle_dataset(str(download_file), archive_file_name, dataset=dataset)

		logger.info(f'Dataset bundle completed for dataset {dataset_id}')

	except Exception as e:
		logger.error(f'Error in background dataset bundling: {str(e)}', extra={'dataset_id': dataset_id})
		# Remove failed file if it exists
		if download_file.exists():
			download_file.unlink()


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


@download_app.get('/datasets/{dataset_id}/labels.gpkg')
async def get_labels(dataset_id: str, background_tasks: BackgroundTasks):
	"""
	Download all the labels of the dataset with the given ID.
	"""
	# Load the dataset to verify it exists
	with use_client() as client:
		# Get dataset data
		dataset_response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()
		if not dataset_response.data:
			raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> not found.')
		dataset = Dataset(**dataset_response.data[0])

		# Check if dataset has any labels
		label_response = client.table(settings.labels_table).select('*').eq('dataset_id', dataset_id).execute()
		if not label_response.data:
			raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> has no labels.')

		# Convert to Label objects
		labels = [Label(**label_data) for label_data in label_response.data]

	# Create a temporary directory for files
	temp_dir = tempfile.mkdtemp()
	background_tasks.add_task(lambda: shutil.rmtree(temp_dir))

	# Create ZIP archive
	zip_file = Path(temp_dir) / f'labels_{dataset_id}.zip'

	with zipfile.ZipFile(zip_file, 'w', zipfile.ZIP_STORED) as archive:
		# Group labels by type
		label_types = set(label.label_data for label in labels)

		for label_type in label_types:
			# Create GeoPackage for this label type
			type_labels = [label for label in labels if label.label_data == label_type]
			gpkg_file = Path(temp_dir) / f'{label_type.value}_{dataset_id}.gpkg'

			# Process each label into the GeoPackage
			for label in type_labels:
				label_to_geopackage(str(gpkg_file), label)

			# Add to archive
			archive.write(gpkg_file, arcname=f'labels_{label_type.value}_{dataset_id}.gpkg')

		# Add citation file
		citation_buffer = io.StringIO()
		create_citation_file(dataset, citation_buffer)
		archive.writestr('CITATION.cff', citation_buffer.getvalue())

	# Return the ZIP file
	return FileResponse(zip_file, media_type='application/zip', filename=f'labels_{dataset_id}.zip')
