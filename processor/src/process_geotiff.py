from pathlib import Path
import time

from shared.db import use_client, login, verify_token
from shared.status import update_status
from shared.settings import settings
from shared.models import StatusEnum, Ortho, QueueTask
from shared.logger import logger
from shared.ortho import upsert_ortho_entry
from .utils.ssh import pull_file_from_storage_server, push_file_to_storage_server
from .exceptions import AuthenticationError, DatasetError, ProcessingError
from .geotiff.convert_geotiff import convert_geotiff, verify_geotiff
from rio_cogeo.cogeo import cog_info
from shared.hash import get_file_identifier
from shared.logging import LogContext, LogCategory


def process_geotiff(task: QueueTask, temp_dir: Path):
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
	user = verify_token(token)
	if not user:
		raise AuthenticationError('Invalid processor token', token=token, task_id=task.id)

	# Update initial status
	update_status(token, dataset_id=task.dataset_id, current_status=StatusEnum.ortho_processing)

	try:
		with use_client(token) as client:
			response = client.table(settings.orthos_table).select('*').eq('dataset_id', task.dataset_id).execute()
			ortho = Ortho(**response.data[0])
	except Exception as e:
		update_status(
			token, dataset_id=task.dataset_id, has_error=True, error_message=f'Failed to fetch dataset: {str(e)}'
		)
		raise DatasetError(f'Failed to fetch dataset: {str(e)}', dataset_id=task.dataset_id, task_id=task.id)

	try:
		# Setup paths
		path_original = temp_dir / f'original_{ortho.ortho_file_name}'
		path_converted = temp_dir / f'{ortho.ortho_file_name}'

		# Get storage server path
		storage_server_path = f'{settings.STORAGE_SERVER_DATA_PATH}/archive/{ortho.ortho_file_name}'

		# Pull original file
		pull_file_from_storage_server(storage_server_path, str(path_original), token)

		# Start conversion
		t1 = time.time()
		logger.info(
			'Starting GeoTIFF conversion',
			LogContext(category=LogCategory.ORTHO, dataset_id=task.dataset_id, user_id=user.id, token=token),
		)

		if not convert_geotiff(str(path_original), str(path_converted), token):
			raise ProcessingError(
				'Conversion failed', task_type='convert', task_id=task.id, dataset_id=ortho.dataset_id
			)

		# Verify converted file
		logger.info(
			'Verifying converted GeoTIFF',
			LogContext(category=LogCategory.ORTHO, dataset_id=task.dataset_id, user_id=user.id, token=token),
		)
		if not verify_geotiff(str(path_converted), token):
			raise ProcessingError(
				'Converted file verification failed', task_type='convert', task_id=task.id, dataset_id=ortho.dataset_id
			)

		t2 = time.time()
		ortho_processing_runtime = t2 - t1

		# If verification successful, replace original file on storage server
		logger.info(
			'Pushing converted file to storage server',
			LogContext(category=LogCategory.ORTHO, dataset_id=task.dataset_id, user_id=user.id, token=token),
		)
		push_file_to_storage_server(str(path_converted), storage_server_path, token)

		# Update ortho entry with processing information
		sha256 = get_file_identifier(path_converted)
		ortho_info = cog_info(str(path_converted))

		upsert_ortho_entry(
			dataset_id=ortho.dataset_id,
			file_path=path_converted,
			ortho_processing_runtime=ortho_processing_runtime,
			ortho_info=ortho_info.model_dump(),
			version=1,
			sha256=sha256,
			ortho_processed=True,
			token=token,
		)

		# Log conversion time
		logger.info(
			f'GeoTIFF conversion completed in {t2 - t1:.2f} seconds',
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=ortho.dataset_id,
				user_id=user.id,
				token=token,
				extra={'processing_time': t2 - t1},
			),
		)

		# Clean up local files
		path_original.unlink()

	except Exception as e:
		# Update error status
		update_status(token, dataset_id=ortho.dataset_id, has_error=True, error_message=str(e))
		# Clean up files on error
		if path_original.exists():
			path_original.unlink()
		if path_converted.exists():
			path_converted.unlink()

		logger.error(
			f'GeoTIFF processing failed: {str(e)}',
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=ortho.dataset_id,
				user_id=user.id,
				token=token,
				extra={'error': str(e)},
			),
		)
		raise ProcessingError(str(e), task_type='convert', task_id=task.id, dataset_id=ortho.dataset_id)

	# Update final status
	update_status(token, dataset_id=ortho.dataset_id, current_status=StatusEnum.idle, is_ortho_done=True)

	logger.info(
		f'Finished converting dataset {ortho.dataset_id}',
		LogContext(category=LogCategory.ORTHO, dataset_id=ortho.dataset_id, user_id=user.id, token=token),
	)
