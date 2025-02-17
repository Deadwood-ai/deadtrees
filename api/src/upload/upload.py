from pathlib import Path
import rasterio
import hashlib
import shutil
import time

from rasterio.env import Env
from rasterio.warp import transform_bounds

from fastapi import HTTPException

from shared.models import Dataset, StatusEnum
from shared.supabase import use_client, login
from shared.settings import settings
from shared.logger import logger

# from .update_metadata_admin_level import update_metadata_admin_level


def format_size(size: int) -> str:
	"""Converting the filesize of the geotiff into a human readable format for the logger

	Args:
	    size (int): File size in bytes

	Returns:
	    str: A proper human readable size string in bytes, KB, MB or GB
	"""
	if size < 1024:
		return f'{size} bytes'
	elif size < 1024**2:
		return f'{size / 1024:.2f} KB'
	elif size < 1024**3:
		return f'{size / 1024**2:.2f} MB'
	else:
		return f'{size / 1024**3:.2f} GB'


def get_transformed_bounds(file_path: Path):
	"""Get transformed bounds from GeoTIFF"""
	with Env(GTIFF_SRS_SOURCE='EPSG'):
		with rasterio.open(str(file_path), 'r') as src:
			try:
				return transform_bounds(src.crs, 'EPSG:4326', *src.bounds)
			except Exception as e:
				logger.error(f'No CRS found for {file_path}: {e}')
				return None


def get_file_identifier(file_path: Path, sample_size: int = 10 * 1024 * 1024) -> str:
	"""Generate a quick file identifier by sampling start/end of file"""
	file_size = file_path.stat().st_size
	hasher = hashlib.sha256()

	with open(file_path, 'rb') as f:
		# Hash file size
		hasher.update(str(file_size).encode())

		# Hash first 10MB
		hasher.update(f.read(sample_size))

		# Hash last 10MB
		f.seek(-min(sample_size, file_size), 2)
		hasher.update(f.read(sample_size))

	return hasher.hexdigest()


def create_initial_dataset_entry(
	filename: str, file_alias: str, user_id: str, copy_time: int, file_size: int, sha256: str, bbox, token: str
) -> Dataset:
	"""Create an initial dataset entry with available information."""
	data = dict(
		file_name=filename,
		file_alias=file_alias,
		status=StatusEnum.uploaded,
		user_id=user_id,
		copy_time=copy_time,
		file_size=file_size,
		sha256=sha256,
		bbox=bbox,
	)
	dataset = Dataset(**data)
	print(dataset)

	with use_client(token) as client:
		try:
			send_data = {k: v for k, v in dataset.model_dump().items() if k != 'id' and v is not None}
			response = client.table(settings.datasets_table).insert(send_data).execute()
		except Exception as e:
			logger.exception(f'Error creating initial dataset entry: {str(e)}', extra={'token': token})
			raise HTTPException(status_code=400, detail=f'Error creating initial dataset entry: {str(e)}')

	return Dataset(**response.data[0])


# def update_dataset_entry(dataset_id: int, file_size: int, sha256: str, bbox):
# 	"""Update the existing dataset entry with processed information."""

# 	token = login(settings.processing_username, settings.processing_password)

# 	data = dict(
# 		file_name=None,
# 		file_alias=None,
# 		copy_time=None,
# 		user_id=None,
# 		file_size=file_size,
# 		sha256=sha256,
# 		bbox=bbox,
# 		status=StatusEnum.uploaded,
# 	)
# 	dataset_update = Dataset(**data)

# 	with use_client(token) as client:
# 		try:
# 			client.table(settings.datasets_table).update(
# 				dataset_update.model_dump(include={'file_size', 'sha256', 'bbox', 'status'})
# 			).eq('id', dataset_id).execute()
# 		except Exception as e:
# 			logger.exception(f'Error updating dataset: {str(e)}', extra={'token': token})
# 			raise HTTPException(status_code=400, detail=f'Error updating dataset: {str(e)}')


# def assemble_chunks(upload_id: str, new_file_name: str, chunks_total: int, temp_dir: str, dataset: Dataset) -> Dataset:
# 	"""Assemble chunks into final file"""
# 	temp_dir = Path(temp_dir)
# 	target_path = settings.archive_path / new_file_name

# 	logger.info(f'Assembling chunks for {target_path}')

# 	# Explicit conversion to ensure chunks_total is int
# 	chunks_total = int(chunks_total)

# 	# Assemble chunks
# 	with open(target_path, 'wb') as outfile:
# 		for i in range(chunks_total):
# 			chunk_path = Path(temp_dir) / f'chunk_{i}'
# 			with open(chunk_path, 'rb') as infile:
# 				shutil.copyfileobj(infile, outfile)
# 	logger.info(f'Chunks assembled')

# 	# Cleanup chunk files, dont delet parent folder
# 	shutil.rmtree(temp_dir)

# 	# Proceed with hashing and bounds extraction
# 	try:
# 		# Get file identifier
# 		start_hashing = time.time()
# 		final_hash = get_file_identifier(target_path)
# 		hash_time = time.time() - start_hashing

# 		logger.info(
# 			f'Hashing took {hash_time:.2f}s for {target_path.stat().st_size / (1024 ** 3):.2f} GB',
# 			# extra={'token': token},
# 		)

# 		# Get bounds
# 		start_bounds = time.time()
# 		bbox = get_transformed_bounds(target_path)
# 		bounds_time = time.time() - start_bounds

# 		file_size = target_path.stat().st_size

# 		logger.info(
# 			f'Getting bounds took {bounds_time:.2f}s',
# 			# extra={'token': token},
# 		)

# 		# Update dataset entry
# 		logger.info(f'Updating dataset entry for {dataset.id}')
# 		dataset = update_dataset_entry(
# 			dataset_id=dataset.id,
# 			file_size=file_size,
# 			sha256=final_hash,
# 			bbox=bbox,
# 		)

# 		return dataset

# 	except Exception as e:
# 		logger.exception(f'Error assembling chunks: {e}', extra={'token': token})
# 		raise HTTPException(status_code=500, detail=str(e))
