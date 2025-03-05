from datetime import datetime
from pathlib import Path
from typing import Optional

from shared.models import Ortho
from shared.db import use_client
from shared.settings import settings
from shared.logger import logger
from shared.utils import get_transformed_bounds, format_bbox_string


def upsert_ortho_entry(
	dataset_id: int,
	file_path: Path,
	version: int,
	token: str,
	sha256: Optional[str] = None,
	ortho_original_info: Optional[dict] = None,
	ortho_processed_info: Optional[dict] = None,
	ortho_upload_runtime: Optional[float] = None,
	ortho_processing_runtime: Optional[float] = None,
	ortho_processed: Optional[bool] = None,
) -> Ortho:
	"""Create or update an ortho entry in the database"""
	try:
		# Get bbox from file if not processed yet
		bbox = get_transformed_bounds(file_path)
		bbox_string = format_bbox_string(bbox)

		# Prepare ortho data
		ortho_data = {
			'dataset_id': dataset_id,
			'ortho_file_name': file_path.name,
			'version': version,
			'ortho_file_size': max(1, int((file_path.stat().st_size / 1024 / 1024))),  # in MB
			'bbox': bbox_string,
			'sha256': sha256,
			'ortho_original_info': dict(ortho_original_info) if ortho_original_info is not None else None,
			'ortho_processed_info': dict(ortho_processed_info) if ortho_processed_info is not None else None,
			'ortho_upload_runtime': ortho_upload_runtime,
			'ortho_processing_runtime': ortho_processing_runtime,
			'ortho_processed': ortho_processed if ortho_processed is not None else False,
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
