from pathlib import Path

from shared.db import use_client, login, verify_token
from shared.settings import settings
from shared.models import StatusEnum, Ortho, QueueTask
from shared.logger import logger
from shared.status import update_status
from shared.logging import LogContext, LogCategory

from .utils.ssh import pull_file_from_storage_server
from .treecover.predict_treecover import predict_treecover
from .exceptions import AuthenticationError, DatasetError, ProcessingError


def process_treecover(task: QueueTask, token: str, temp_dir: Path):
	"""Process tree cover detection for a given dataset.
	
	Args:
		task (QueueTask): The queue task containing dataset information
		token (str): Authentication token
		temp_dir (Path): Temporary directory for file processing
	"""
	# Move import inside function so it's only loaded when needed
	import torch

	# login with the processor
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

	user = verify_token(token)
	if not user:
		logger.error(
			'Invalid processor token',
			LogContext(category=LogCategory.AUTH, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
		)
		raise AuthenticationError('Invalid token')

	try:
		with use_client(token) as client:
			response = client.table(settings.orthos_table).select('*').eq('dataset_id', task.dataset_id).execute()
			ortho = Ortho(**response.data[0])
	except Exception as e:
		logger.error(
			'Failed to fetch ortho data',
			LogContext(
				category=LogCategory.FOREST,
				dataset_id=task.dataset_id,
				user_id=user.id,
				token=token,
				extra={'error': str(e)},
			),
		)
		raise DatasetError(f'Error fetching dataset: {e}')

	# Update initial status
	update_status(token, dataset_id=ortho.dataset_id, current_status=StatusEnum.forest_cover_segmentation)
	logger.info(
		'Starting tree cover detection',
		LogContext(category=LogCategory.FOREST, dataset_id=task.dataset_id, user_id=user.id, token=token),
	)

	# get local file path
	file_path = Path(temp_dir) / ortho.ortho_file_name
	# get the remote file path
	storage_server_file_path = f'{settings.STORAGE_SERVER_DATA_PATH}/archive/{ortho.ortho_file_name}'

	logger.info(
		'Pulling file from storage server',
		LogContext(
			category=LogCategory.FOREST,
			dataset_id=task.dataset_id,
			user_id=user.id,
			token=token,
			extra={'file_path': str(file_path), 'storage_path': storage_server_file_path},
		),
	)
	pull_file_from_storage_server(storage_server_file_path, str(file_path), token, ortho.dataset_id)

	try:
		logger.info(
			'Running tree cover detection',
			LogContext(
				category=LogCategory.FOREST,
				dataset_id=task.dataset_id,
				user_id=user.id,
				token=token,
				extra={'file_path': str(file_path)},
			),
		)
		predict_treecover(task.dataset_id, file_path, user.id, token)

		# Force CUDA cache cleanup if using GPU
		if torch.cuda.is_available():
			logger.info(
				'Cleaning CUDA cache',
				LogContext(category=LogCategory.FOREST, dataset_id=task.dataset_id, user_id=user.id, token=token),
			)
			torch.cuda.empty_cache()

		# Update successful completion status
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		update_status(token, dataset_id=ortho.dataset_id, current_status=StatusEnum.idle, is_forest_cover_done=True)

		logger.info(
			'Tree cover detection completed successfully',
			LogContext(
				category=LogCategory.FOREST,
				dataset_id=task.dataset_id,
				user_id=user.id,
				token=token,
			),
		)

	except Exception as e:
		if torch.cuda.is_available():
			torch.cuda.empty_cache()
		logger.error(
			'Tree cover detection failed',
			LogContext(
				category=LogCategory.FOREST,
				dataset_id=ortho.dataset_id,
				user_id=user.id,
				token=token,
				extra={'error': str(e)},
			),
		)
		update_status(token, dataset_id=ortho.dataset_id, has_error=True, error_message=str(e))
		raise ProcessingError(str(e), task_type='forest_cover_segmentation', task_id=task.id, dataset_id=ortho.dataset_id) 