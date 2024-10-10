from threading import Timer

from .models import QueueTask
from .settings import settings
from .supabase import use_client, login
from .processing import process_cog, process_thumbnail
from .logger import logger


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


def process_task(task: QueueTask, token: str):
	try:
		# mark this task as processing
		with use_client(token) as client:
			client.table(settings.queue_table).update({'is_processing': True}).eq('id', task.id).execute()

		if task.task_type in ['cog', 'all']:
			process_cog(task, settings.tmp_processing_path)

		if task.task_type in ['thumbnail', 'all']:
			process_thumbnail(task, settings.tmp_processing_path)

		# delete the task from the queue if processing was successful
		with use_client(token) as client:
			client.table(settings.queue_table).delete().eq('id', task.id).execute()

	except Exception as e:
		# log the error to the database
		msg = f'PROCESSOR error processing task {task.id}: {str(e)}'
		logger.error(msg, extra={'token': token, 'task_id': task.id})
	finally:
		# unlik temp folder
		shutil.rmtree(settings.tmp_processing_path)


def background_process():
	"""
	This process checks if there is anything to do in the queue.
	If so, it checks the currently running tasks against the maximum allowed tasks.
	If another task can be started, it will do so, if not, the background_process is
	added to the FastAPI background tasks with a configured delay.

	"""
	# use the processor to log in
	token = login(settings.processor_username, settings.processor_password).session.access_token

	# get the number of currently running tasks
	num_of_running = current_running_tasks(token)
	queued_tasks = queue_length(token)

	# is there is nothing in the queue, just stop the process and log
	if queued_tasks == 0:
		logger.info('No tasks in the queue.', extra={'token': token})
		return

	# check if we can start another task
	if num_of_running < settings.concurrent_tasks:
		# get the next task
		task = get_next_task(token)
		if task is not None:
			logger.info(
				f'Start a new background process for queued task: {task}.',
				extra={
					'token': token,
					'user_id': task.user_id,
					'dataset_id': task.dataset_id,
				},
			)
			process_task(task, token=token)

			# add another background process with a short timeout
			Timer(interval=1, function=background_process).start()
		else:
			# we expected a task here, but there was None
			logger.error(
				'Expected a task to process, but none was in the queue.',
				extra={'token': token},
			)
	else:
		# inform no spot available
		logger.debug(
			f'No spot available for new task. Retry in {settings.task_retry_delay} seconds.',
			extra={'token': token},
		)
		# restart this process after the configured delay
		Timer(interval=settings.task_retry_delay, function=background_process).start()


if __name__ == '__main__':
	background_process()
