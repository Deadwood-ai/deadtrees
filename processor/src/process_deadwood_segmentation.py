from pathlib import Path

from shared.db import use_client, login, verify_token
from shared.settings import settings
from shared.models import StatusEnum, Dataset, QueueTask
from shared.logger import logger
from shared.status import update_status
from shared.logging import LogContext, LogCategory

from .utils.ssh import pull_file_from_storage_server
from .deadwood_segmentation.predict_deadwood import predict_deadwood
from .exceptions import AuthenticationError, DatasetError, ProcessingError


def process_deadwood_segmentation(task: QueueTask, token: str, temp_dir: Path):
	# login with the processor
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

	user = verify_token(token)
	if not user:
		raise AuthenticationError('Invalid token')

	try:
		with use_client(token) as client:
			response = client.table(settings.datasets_table).select('*').eq('id', task.dataset_id).execute()
			dataset = Dataset(**response.data[0])
	except Exception as e:
		logger.error(
			f'Error: {e}',
			LogContext(category=LogCategory.ERROR, dataset_id=task.dataset_id, user_id=user.id, token=token),
		)
		raise DatasetError(f'Error fetching dataset: {e}')

	# Update initial status
	update_status(token, dataset_id=dataset.id, current_status=StatusEnum.deadwood_segmentation)

	# get local file path
	file_path = Path(temp_dir) / dataset.file_name
	# get the remote file path
	storage_server_file_path = f'{settings.STORAGE_SERVER_DATA_PATH}/archive/{dataset.file_name}'
	pull_file_from_storage_server(storage_server_file_path, str(file_path), token)

	try:
		logger.info(
			f'Running deadwood segmentation for dataset {task.dataset_id} with file path {str(file_path)}',
			LogContext(category=LogCategory.PROCESS, dataset_id=task.dataset_id, user_id=user.id, token=token),
		)
		predict_deadwood(task.dataset_id, file_path, user.id, token)

		# Update successful completion status
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		update_status(token, dataset_id=dataset.id, current_status=StatusEnum.idle, is_deadwood_done=True)

		logger.info(f'Deadwood segmentation completed for dataset {task.dataset_id}', extra={'token': token})

	except Exception as e:
		logger.error(
			f'Error in deadwood segmentation: {e}',
			LogContext(category=LogCategory.ERROR, dataset_id=dataset.id, user_id=user.id, token=token),
		)
		update_status(token, dataset_id=dataset.id, has_error=True, error_message=str(e))
		raise ProcessingError(str(e), task_type='deadwood_segmentation', task_id=task.id, dataset_id=dataset.id)
