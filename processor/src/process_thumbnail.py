from pathlib import Path
import time

from shared.db import use_client, login, verify_token
from shared.settings import settings
from shared.models import StatusEnum, Ortho, QueueTask, Thumbnail
from shared.logger import logger
from .thumbnail.thumbnail import calculate_thumbnail
from .utils.ssh import pull_file_from_storage_server, push_file_to_storage_server
from .exceptions import AuthenticationError, DatasetError, ProcessingError, StorageError
from shared.status import update_status
from shared.logging import LogContext, LogCategory


def process_thumbnail(task: QueueTask, temp_dir: Path):
	# login with the processor
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

	user = verify_token(token)
	if not user:
		logger.error(
			'Invalid processor token',
			LogContext(category=LogCategory.AUTH, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
		)
		raise AuthenticationError('Invalid processor token', token=token, task_id=task.id)

	# load the dataset
	try:
		with use_client(token) as client:
			response = client.table(settings.orthos_table).select('*').eq('dataset_id', task.dataset_id).execute()
			ortho = Ortho(**response.data[0])
	except Exception as e:
		logger.error(
			f'Failed to fetch dataset: {str(e)}',
			LogContext(category=LogCategory.DATASET, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
		)
		raise DatasetError(f'Failed to fetch dataset: {str(e)}', dataset_id=task.dataset_id, task_id=task.id)

	# update the status to processing
	update_status(token, dataset_id=ortho.dataset_id, current_status=StatusEnum.thumbnail_processing)

	try:
		# get local file paths
		thumbnail_file_name = ortho.ortho_file_name.replace('_ortho.tif', '_thumbnail.jpg')

		# Always use temp_dir for both input and output
		input_path = temp_dir / ortho.ortho_file_name
		output_path = temp_dir / thumbnail_file_name

		logger.info(
			'Processing thumbnail paths',
			LogContext(
				category=LogCategory.THUMBNAIL,
				dataset_id=task.dataset_id,
				user_id=task.user_id,
				token=token,
				extra={'temp_dir': str(temp_dir), 'input': str(input_path), 'output': str(output_path)},
			),
		)

		# get the remote file path and pull file
		storage_server_file_path = f'{settings.STORAGE_SERVER_DATA_PATH}/archive/{ortho.ortho_file_name}'
		pull_file_from_storage_server(storage_server_file_path, str(input_path), token, task.dataset_id)

		# Generate thumbnail
		t1 = time.time()
		logger.info(
			'Starting thumbnail generation',
			LogContext(category=LogCategory.THUMBNAIL, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
		)
		calculate_thumbnail(str(input_path), str(output_path))
		logger.info(
			'Thumbnail generated successfully',
			LogContext(
				category=LogCategory.THUMBNAIL,
				dataset_id=task.dataset_id,
				user_id=task.user_id,
				token=token,
				extra={'output_path': str(output_path)},
			),
		)

		# Push thumbnail to storage
		storage_server_thumbnail_path = f'{settings.STORAGE_SERVER_DATA_PATH}/thumbnails/{thumbnail_file_name}'
		push_file_to_storage_server(str(output_path), storage_server_thumbnail_path, token, task.dataset_id)
		t2 = time.time()

		# Prepare metadata
		meta = dict(
			dataset_id=ortho.dataset_id,
			thumbnail_file_size=max(1, int((output_path.stat().st_size))),
			thumbnail_file_name=thumbnail_file_name,
			thumbnail_path=thumbnail_file_name,
			version=1,
			thumbnail_processing_runtime=t2 - t1,
		)
		thumbnail = Thumbnail(**meta)

	except Exception as e:
		logger.error(
			f'Thumbnail processing failed: {str(e)}',
			LogContext(
				category=LogCategory.THUMBNAIL,
				dataset_id=task.dataset_id,
				user_id=task.user_id,
				token=token,
				extra={'error': str(e)},
			),
		)
		update_status(token, dataset_id=ortho.dataset_id, has_error=True, error_message=str(e))
		raise ProcessingError(str(e), task_type='thumbnail', task_id=task.id, dataset_id=ortho.dataset_id)

	# Save thumbnail metadata to database
	try:
		# Refresh token before database operation
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		user = verify_token(token)
		if not user:
			logger.error(
				'Token refresh failed',
				LogContext(category=LogCategory.AUTH, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
			)
			raise AuthenticationError('Token refresh failed', token=token, task_id=task.id)

		with use_client(token) as client:
			client.table(settings.thumbnails_table).upsert(
				thumbnail.model_dump(),
				on_conflict='dataset_id',
			).execute()

			update_status(token, dataset_id=ortho.dataset_id, current_status=StatusEnum.idle, is_thumbnail_done=True)
			logger.info(
				'Thumbnail metadata saved to database',
				LogContext(
					category=LogCategory.THUMBNAIL,
					dataset_id=task.dataset_id,
					user_id=task.user_id,
					token=token,
					extra={'thumbnail_size': thumbnail.thumbnail_file_size},
				),
			)
	except Exception as e:
		logger.error(
			f'Failed to save thumbnail metadata: {str(e)}',
			LogContext(
				category=LogCategory.THUMBNAIL,
				dataset_id=task.dataset_id,
				user_id=task.user_id,
				token=token,
				extra={'error': str(e)},
			),
		)
		update_status(token, dataset_id=ortho.dataset_id, has_error=True, error_message=str(e))
		raise DatasetError(f'Failed to save thumbnail metadata: {str(e)}', dataset_id=ortho.dataset_id, task_id=task.id)

	# Update final status
	update_status(token, dataset_id=ortho.dataset_id, current_status=StatusEnum.idle, is_thumbnail_done=True)
	logger.info(
		'Thumbnail processing completed successfully',
		LogContext(
			category=LogCategory.THUMBNAIL,
			dataset_id=task.dataset_id,
			user_id=task.user_id,
			token=token,
			extra={'processing_time': t2 - t1},
		),
	)
