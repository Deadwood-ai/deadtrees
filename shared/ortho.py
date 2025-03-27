from datetime import datetime
from pathlib import Path
from typing import Optional

from shared.models import Ortho, ProcessedOrtho
from shared.db import use_client
from shared.settings import settings
from shared.logger import logger
from shared.utils import get_transformed_bounds, format_bbox_string


def sanitize_json_data(data):
	"""Recursively sanitize data to ensure JSON compliance by converting non-compliant values to strings."""
	if isinstance(data, dict):
		return {k: sanitize_json_data(v) for k, v in data.items()}
	elif isinstance(data, (list, tuple)):
		return [sanitize_json_data(item) for item in data]
	elif isinstance(data, float) and (str(data) == 'nan' or str(data) == 'inf' or str(data) == '-inf'):
		return str(data)
	elif hasattr(data, '__dict__'):
		return sanitize_json_data(data.__dict__)
	return data


def upsert_ortho_entry(
	dataset_id: int,
	file_path: Path,
	version: int,
	token: str,
	sha256: Optional[str] = None,
	ortho_info: Optional[dict] = None,
	ortho_upload_runtime: Optional[float] = None,
) -> Ortho:
	"""Create or update an original ortho entry in the database"""
	try:
		# Get bbox from file
		bbox = get_transformed_bounds(file_path)
		bbox_string = format_bbox_string(bbox)

		# Sanitize ortho_info if present
		sanitized_ortho_info = sanitize_json_data(ortho_info) if ortho_info is not None else None

		# Prepare ortho data
		ortho_data = {
			'dataset_id': dataset_id,
			'ortho_file_name': file_path.name,
			'version': version,
			'ortho_file_size': max(1, int((file_path.stat().st_size / 1024 / 1024))),  # in MB
			'bbox': bbox_string,
			'sha256': sha256,
			'ortho_info': sanitized_ortho_info,
			'ortho_upload_runtime': ortho_upload_runtime,
		}

		# Remove None values
		ortho_data = {k: v for k, v in ortho_data.items() if v is not None}
		ortho = Ortho(**ortho_data)

		with use_client(token) as client:
			send_data = {k: v for k, v in ortho.model_dump().items() if k != 'id' and v is not None}
			response = client.table(settings.orthos_table).upsert(send_data).execute()
			return Ortho(**response.data[0])

	except Exception as e:
		logger.exception(f'Error upserting ortho entry: {str(e)}', extra={'token': token})
		raise Exception(f'Error upserting ortho entry: {str(e)}')


def upsert_processed_ortho_entry(
	dataset_id: int,
	file_path: Path,
	version: int,
	token: str,
	sha256: Optional[str] = None,
	ortho_info: Optional[dict] = None,
	ortho_processing_runtime: Optional[float] = None,
) -> ProcessedOrtho:
	"""Create or update a processed ortho entry in the database"""
	try:
		# Get bbox from file
		bbox = get_transformed_bounds(file_path)
		bbox_string = format_bbox_string(bbox)

		# Sanitize ortho_info if present
		sanitized_ortho_info = sanitize_json_data(ortho_info) if ortho_info is not None else None

		# Prepare processed ortho data
		processed_ortho_data = {
			'dataset_id': dataset_id,
			'ortho_file_name': file_path.name,
			'version': version,
			'ortho_file_size': max(1, int((file_path.stat().st_size / 1024 / 1024))),  # in MB
			'bbox': bbox_string,
			'sha256': sha256,
			'ortho_info': sanitized_ortho_info,
			'ortho_processing_runtime': ortho_processing_runtime,
		}

		# Remove None values
		processed_ortho_data = {k: v for k, v in processed_ortho_data.items() if v is not None}
		processed_ortho = ProcessedOrtho(**processed_ortho_data)

		with use_client(token) as client:
			send_data = {k: v for k, v in processed_ortho.model_dump().items() if k != 'id' and v is not None}
			response = client.table(settings.orthos_processed_table).upsert(send_data).execute()
			return ProcessedOrtho(**response.data[0])

	except Exception as e:
		logger.exception(f'Error upserting processed ortho entry: {str(e)}', extra={'token': token})
		raise Exception(f'Error upserting processed ortho entry: {str(e)}')
