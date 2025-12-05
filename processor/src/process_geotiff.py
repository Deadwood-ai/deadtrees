from pathlib import Path
import time

from shared.db import use_client, login, verify_token
from shared.status import update_status
from shared.settings import settings
from shared.models import StatusEnum, Ortho, QueueTask
from shared.logger import logger
from shared.ortho import upsert_processed_ortho_entry, upsert_ortho_entry
from .utils.ssh import pull_file_from_storage_server, push_file_to_storage_server
from .exceptions import AuthenticationError, DatasetError, ProcessingError, ConversionError
from .geotiff.standardise_geotiff import standardise_geotiff, verify_geotiff
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
		# Check if ortho entry exists, if not create it
		with use_client(token) as client:
			response = client.table(settings.orthos_table).select('*').eq('dataset_id', task.dataset_id).execute()

		if response.data:
			# Existing ortho entry found - always recalculate and update metadata
			ortho_data = response.data[0]
			ortho = Ortho(**ortho_data)

			logger.info(
				'Found existing ortho entry, updating with fresh metadata',
				LogContext(category=LogCategory.ORTHO, dataset_id=task.dataset_id, user_id=user.id, token=token),
			)

			# Pull orthomosaic file to calculate fresh metadata
			ortho_file_name = f'{task.dataset_id}_ortho.tif'
			storage_server_ortho_path = f'{settings.STORAGE_SERVER_DATA_PATH}/archive/{ortho_file_name}'
			temp_ortho_path = temp_dir / ortho_file_name

			try:
				pull_file_from_storage_server(storage_server_ortho_path, str(temp_ortho_path), token, task.dataset_id)
			except Exception as e:
				error_msg = f'Missing orthomosaic file at {storage_server_ortho_path}: {str(e)}'
				logger.error(
					error_msg,
					LogContext(category=LogCategory.ORTHO, dataset_id=task.dataset_id, user_id=user.id, token=token),
				)
				raise DatasetError(error_msg, dataset_id=task.dataset_id, task_id=task.id)

			# Verify file was successfully pulled
			if not temp_ortho_path.exists():
				error_msg = f'Orthomosaic file not found after transfer from {storage_server_ortho_path}'
				logger.error(
					error_msg,
					LogContext(category=LogCategory.ORTHO, dataset_id=task.dataset_id, user_id=user.id, token=token),
				)
				raise DatasetError(error_msg, dataset_id=task.dataset_id, task_id=task.id)

			# Always recalculate metadata
			sha256 = get_file_identifier(temp_ortho_path)
			ortho_info = cog_info(str(temp_ortho_path))

			# Update ortho entry with fresh metadata
			ortho = upsert_ortho_entry(
				dataset_id=task.dataset_id,
				file_path=temp_ortho_path,
				version=ortho.version,
				token=token,
				sha256=sha256,
				ortho_info=ortho_info.model_dump(),
			)

			logger.info(
				'Updated ortho entry with fresh metadata',
				LogContext(category=LogCategory.ORTHO, dataset_id=task.dataset_id, user_id=user.id, token=token),
			)

			# Clean up temporary file
			temp_ortho_path.unlink()
		else:
			# No ortho entry exists, create one by finding orthomosaic file
			logger.info(
				'No ortho entry found, creating from orthomosaic file',
				LogContext(category=LogCategory.ORTHO, dataset_id=task.dataset_id, user_id=user.id, token=token),
			)

			# Find orthomosaic at archive/{dataset_id}_ortho.tif
			ortho_file_name = f'{task.dataset_id}_ortho.tif'
			storage_server_ortho_path = f'{settings.STORAGE_SERVER_DATA_PATH}/archive/{ortho_file_name}'
			temp_ortho_path = temp_dir / ortho_file_name

			# Pull orthomosaic file to calculate hash and info
			try:
				pull_file_from_storage_server(storage_server_ortho_path, str(temp_ortho_path), token, task.dataset_id)
			except Exception as e:
				error_msg = f'Missing orthomosaic file at {storage_server_ortho_path}: {str(e)}'
				logger.error(
					error_msg,
					LogContext(category=LogCategory.ORTHO, dataset_id=task.dataset_id, user_id=user.id, token=token),
				)
				raise DatasetError(error_msg, dataset_id=task.dataset_id, task_id=task.id)

			# Verify file was successfully pulled
			if not temp_ortho_path.exists():
				error_msg = f'Orthomosaic file not found after transfer from {storage_server_ortho_path}'
				logger.error(
					error_msg,
					LogContext(category=LogCategory.ORTHO, dataset_id=task.dataset_id, user_id=user.id, token=token),
				)
				raise DatasetError(error_msg, dataset_id=task.dataset_id, task_id=task.id)

			# Calculate SHA256 hash
			sha256 = get_file_identifier(temp_ortho_path)

			# Extract ortho info
			ortho_info = cog_info(str(temp_ortho_path))

			# Create ortho entry
			ortho = upsert_ortho_entry(
				dataset_id=task.dataset_id,
				file_path=temp_ortho_path,
				version=1,
				token=token,
				sha256=sha256,
				ortho_info=ortho_info.model_dump(),
			)

			logger.info(
				'Created ortho entry for dataset',
				LogContext(category=LogCategory.ORTHO, dataset_id=task.dataset_id, user_id=user.id, token=token),
			)

			# Clean up temporary file
			temp_ortho_path.unlink()

	except Exception as e:
		update_status(
			token,
			dataset_id=task.dataset_id,
			has_error=True,
			error_message=f'Failed to fetch or create ortho entry: {str(e)}',
		)
		raise DatasetError(
			f'Failed to fetch or create ortho entry: {str(e)}', dataset_id=task.dataset_id, task_id=task.id
		)

	try:
		# Setup paths
		path_original = temp_dir / f'original_{ortho.ortho_file_name}'
		path_converted = temp_dir / f'{ortho.ortho_file_name}'

		# Get storage server path
		storage_server_path = f'{settings.STORAGE_SERVER_DATA_PATH}/archive/{ortho.ortho_file_name}'

		# Pull original file
		pull_file_from_storage_server(storage_server_path, str(path_original), token, task.dataset_id)

		# Start conversion
		t1 = time.time()
		logger.info(
			'Starting GeoTIFF conversion',
			LogContext(category=LogCategory.ORTHO, dataset_id=task.dataset_id, user_id=user.id, token=token),
		)

		try:
			success = standardise_geotiff(str(path_original), str(path_converted), token, task.dataset_id)
			if not success:
				raise ProcessingError(
					'Conversion failed', task_type='convert', task_id=task.id, dataset_id=ortho.dataset_id
				)
		except ConversionError as e:
			# Re-raise with the specific reason from ConversionError
			raise ProcessingError(e.reason, task_type='convert', task_id=task.id, dataset_id=ortho.dataset_id)

		# Verify converted file
		logger.info(
			'Verifying converted GeoTIFF',
			LogContext(category=LogCategory.ORTHO, dataset_id=task.dataset_id, user_id=user.id, token=token),
		)
		if not verify_geotiff(str(path_converted), token, task.dataset_id):
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
		# push_file_to_storage_server(str(path_converted), storage_server_path, token, task.dataset_id)

		# Update processed ortho entry with processing information
		sha256 = get_file_identifier(path_converted)
		processed_info = cog_info(str(path_converted))

		upsert_processed_ortho_entry(
			dataset_id=ortho.dataset_id,
			file_path=path_converted,
			ortho_processing_runtime=ortho_processing_runtime,
			ortho_info=processed_info.model_dump(),
			version=1,
			sha256=sha256,
			token=token,
		)

		update_status(token, dataset_id=ortho.dataset_id, current_status=StatusEnum.idle, is_ortho_done=True)

		# Log conversion time
		logger.info(
			f'GeoTIFF conversion completed in {ortho_processing_runtime:.2f} seconds',
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=ortho.dataset_id,
				user_id=user.id,
				token=token,
				extra={'processing_time': ortho_processing_runtime},
			),
		)

		# Clean up local files
		path_original.unlink()

	except Exception as e:
		# Update error status
		update_status(token, dataset_id=ortho.dataset_id, has_error=True, error_message=str(e))
		# Clean up files on error
		if 'path_original' in locals() and path_original.exists():
			path_original.unlink()
		if 'path_converted' in locals() and path_converted.exists():
			path_converted.unlink()
		# Clean up temp ortho file if it was created during ortho entry creation or metadata update
		temp_ortho_file = temp_dir / f'{task.dataset_id}_ortho.tif'
		if temp_ortho_file.exists():
			temp_ortho_file.unlink()

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
