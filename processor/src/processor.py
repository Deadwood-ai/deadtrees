import shutil

from processor.src.process_geotiff import process_geotiff
from shared.models import QueueTask, StatusEnum, Dataset, TaskTypeEnum
from shared.settings import settings
from shared.db import use_client, login, verify_token
from shared.logger import logger
from .process_thumbnail import process_thumbnail
from .process_cog import process_cog
from .process_deadwood_segmentation import process_deadwood_segmentation
from .process_metadata import process_metadata
from .exceptions import ProcessorError, AuthenticationError, DatasetError, ProcessingError, StorageError


def current_running_tasks(token: str) -> int:
	"""Get the number of currently actively processing tasks from supabase.

	Args:
	    token (str): Client access token for supabase

	Returns:
	    int: number of currently active tasks
	"""
	with use_client(token) as client:
		response = client.table(settings.queue_table).select('id').eq('is_processing', True).execute()
		num_of_tasks = len(response.data)

	return num_of_tasks


def queue_length(token: str) -> int:
	"""Get the number of tasks in the queue from supabase.

	Args:
	    token (str): Client access token for supabase

	Returns:
	    int: number of all tasks in the queue
	"""
	with use_client(token) as client:
		response = client.table(settings.queue_position_table).select('id').execute()
		num_of_tasks = len(response.data)

	return num_of_tasks


def get_next_task(token: str) -> QueueTask:
	"""Get the next task (QueueTask class) in the queue from supabase.

	Args:
	    token (str): Client access token for supabase

	Returns:
	    QueueTask: The next task in the queue as a QueueTask class instance
	"""
	with use_client(token) as client:
		response = client.table(settings.queue_position_table).select('*').limit(1).execute()
	if not response.data or len(response.data) == 0:
		return None
	return QueueTask(**response.data[0])


def is_dataset_uploaded_or_processed(task: QueueTask, token: str) -> bool:
	"""Check if a dataset is ready for processing by verifying its upload status.

	Args:
	    task (QueueTask): The task to check
	    token (str): Authentication token

	Returns:
	    bool: True if dataset is uploaded and ready for processing
	"""
	with use_client(token) as client:
		response = (
			client.table(settings.statuses_table).select('is_upload_done').eq('dataset_id', task.dataset_id).execute()
		)

		if not response.data:
			logger.warning(
				f'No status found for dataset {task.dataset_id}', extra={'token': token, 'dataset_id': task.dataset_id}
			)
			return False

		is_uploaded = response.data[0]['is_upload_done']
		msg = f'dataset upload status: {is_uploaded}'
		logger.info(msg, extra={'token': token})

		return is_uploaded


def process_task(task: QueueTask, token: str):
	# Verify token
	user = verify_token(token)
	if not user:
		raise AuthenticationError('Invalid token', token=token, task_id=task.id)

	# Process convert_geotiff first if it's in the list
	if TaskTypeEnum.geotiff in task.task_types:
		try:
			process_geotiff(task, settings.processing_path)
		except Exception as e:
			raise ProcessingError(str(e), task_type='geotiff', task_id=task.id, dataset_id=task.dataset_id)

	# Process cog if requested
	if TaskTypeEnum.cog in task.task_types:
		try:
			logger.info(f'processing cog to {settings.processing_path}')
			process_cog(task, settings.processing_path)
		except Exception as e:
			raise ProcessingError(str(e), task_type='cog', task_id=task.id, dataset_id=task.dataset_id)

	# Process thumbnail if requested
	if TaskTypeEnum.thumbnail in task.task_types:
		try:
			logger.info(f'processing thumbnail to {settings.processing_path}')
			process_thumbnail(task, settings.processing_path)
		except Exception as e:
			raise ProcessingError(str(e), task_type='thumbnail', task_id=task.id, dataset_id=task.dataset_id)

	# Process metadata if requested
	if TaskTypeEnum.metadata in task.task_types:
		try:
			logger.info('processing metadata')
			process_metadata(task, settings.processing_path)
		except Exception as e:
			raise ProcessingError(str(e), task_type='metadata', task_id=task.id, dataset_id=task.dataset_id)

	# Process deadwood_segmentation if requested
	if TaskTypeEnum.deadwood in task.task_types:
		try:
			process_deadwood_segmentation(task, token, settings.processing_path)
		except Exception as e:
			raise ProcessingError(
				str(e), task_type='deadwood_segmentation', task_id=task.id, dataset_id=task.dataset_id
			)

	# Delete task after successful processing
	try:
		with use_client(token) as client:
			client.table(settings.queue_table).delete().eq('id', task.id).execute()
	except Exception as e:
		raise ProcessorError(
			f'Failed to delete completed task: {str(e)}', task_type=str(task.task_types), task_id=task.id
		)

	if not settings.DEV_MODE:
		shutil.rmtree(settings.processing_path, ignore_errors=True)


def background_process():
	"""
	This process checks if there is anything to do in the queue.
	If so, it checks the currently running tasks against the maximum allowed tasks.
	If another task can be started, it will do so, if not, the background_process is
	added to the FastAPI background tasks with a configured delay.

	"""
	# use the processor to log in
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
	user = verify_token(token)
	if not user:
		raise Exception(status_code=401, detail='Invalid token')

	# get the number of currently running tasks
	num_of_running = current_running_tasks(token)
	queued_tasks = queue_length(token)

	# is there is nothing in the queue, just stop the process and log
	if queued_tasks == 0:
		# logger.info('No tasks in the queue.', extra={'token': token})
		return

	# check if we can start another task
	if num_of_running < settings.CONCURRENT_TASKS:
		# get the next task
		task = get_next_task(token)
		is_uploaded = is_dataset_uploaded_or_processed(task, token)
		if task is not None and is_uploaded:
			logger.info(
				f'Start a new background process for queued task: {task}.',
				extra={
					'token': token,
					# 'user_id': task.user_id,
					'dataset_id': task.dataset_id,
				},
			)
			process_task(task, token=token)

			# add another background process with a short timeout
			# Timer(interval=1, function=background_process).start()
		else:
			# we expected a task here, but there was None
			logger.error(
				'Task was expected to be uploaded, but was not.',
				extra={'token': token},
			)
	else:
		# inform no spot available
		logger.debug(
			'No spot available for new task.',
			extra={'token': token},
		)
		return
		# restart this process after the configured delay
		# Timer(interval=settings.task_retry_delay, function=background_process).start()


if __name__ == '__main__':
	background_process()
