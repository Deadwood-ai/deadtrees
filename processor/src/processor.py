import shutil
from pathlib import Path
from processor.src.process_geotiff import process_geotiff
from processor.src.process_odm import process_odm
from shared.models import QueueTask, TaskTypeEnum
from shared.settings import settings
from shared.db import use_client, login, verify_token
from .process_thumbnail import process_thumbnail
from .process_cog import process_cog
from .process_deadwood_segmentation import process_deadwood_segmentation
from .process_treecover_segmentation import process_treecover_segmentation
from .process_metadata import process_metadata
from .exceptions import AuthenticationError, ProcessingError
from shared.logging import LogContext, LogCategory, UnifiedLogger, SupabaseHandler

# Initialize logger with proper cleanup
logger = UnifiedLogger(__name__)
logger.add_supabase_handler(SupabaseHandler())


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
	"""Check if a dataset is ready for processing by verifying its upload status and error status.

	Args:
	    task (QueueTask): The task to check
	    token (str): Authentication token

	Returns:
	    bool: True if dataset is uploaded and ready for processing (no errors)
	"""
	with use_client(token) as client:
		response = (
			client.table(settings.statuses_table)
			.select('is_upload_done,has_error')
			.eq('dataset_id', task.dataset_id)
			.execute()
		)

		if not response.data:
			logger.warning(
				f'No status found for dataset {task.dataset_id}', extra={'token': token, 'dataset_id': task.dataset_id}
			)
			return False

		is_uploaded = response.data[0]['is_upload_done']
		has_error = response.data[0].get('has_error', False)  # Default to False if field doesn't exist

		if has_error:
			logger.warning(
				f'Dataset {task.dataset_id} has errors, skipping processing',
				extra={'token': token, 'dataset_id': task.dataset_id},
			)
			return False

		msg = f'dataset upload status: {is_uploaded}'
		logger.info(msg, extra={'token': token})

		return is_uploaded


def process_task(task: QueueTask, token: str):
	# Verify token
	user = verify_token(token)
	if not user:
		logger.error(
			'Invalid token for processing',
			LogContext(category=LogCategory.AUTH, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
		)
		raise AuthenticationError('Invalid token', token=token, task_id=task.id)

	# Log start of processing
	logger.info(
		f'Starting processing for task {task.id}',
		LogContext(
			category=LogCategory.PROCESS,
			dataset_id=task.dataset_id,
			user_id=task.user_id,
			token=token,
			extra={'task_types': [t.value for t in task.task_types]},
		),
	)
	# remove processing path if it exists
	if Path(settings.processing_path).exists():
		shutil.rmtree(settings.processing_path, ignore_errors=True)

	try:
		# Process ODM first if it's in the list (generates orthomosaic for ZIP uploads)
		if TaskTypeEnum.odm_processing in task.task_types:
			try:
				logger.info(
					'Starting ODM processing',
					LogContext(category=LogCategory.ODM, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
				)
				process_odm(task, settings.processing_path)
			except Exception as e:
				logger.error(
					f'ODM processing failed: {str(e)}',
					LogContext(
						category=LogCategory.ODM,
						dataset_id=task.dataset_id,
						user_id=task.user_id,
						token=token,
						extra={'error': str(e)},
					),
				)
				raise ProcessingError(str(e), task_type='odm_processing', task_id=task.id, dataset_id=task.dataset_id)

		# Process convert_geotiff if it's in the list (handles ortho creation for both upload types)
		if TaskTypeEnum.geotiff in task.task_types:
			try:
				logger.info(
					'Starting GeoTIFF conversion',
					LogContext(
						category=LogCategory.ORTHO, dataset_id=task.dataset_id, user_id=task.user_id, token=token
					),
				)
				process_geotiff(task, settings.processing_path)
			except Exception as e:
				logger.error(
					f'GeoTIFF conversion failed: {str(e)}',
					LogContext(
						category=LogCategory.ORTHO,
						dataset_id=task.dataset_id,
						user_id=task.user_id,
						token=token,
						extra={'error': str(e)},
					),
				)
				raise ProcessingError(str(e), task_type='geotiff', task_id=task.id, dataset_id=task.dataset_id)

		# Process metadata if requested
		if TaskTypeEnum.metadata in task.task_types:
			try:
				logger.info(
					'processing metadata',
					LogContext(
						category=LogCategory.METADATA, dataset_id=task.dataset_id, user_id=task.user_id, token=token
					),
				)
				process_metadata(task, settings.processing_path)
			except Exception as e:
				logger.error(
					f'Metadata processing failed: {str(e)}',
					LogContext(
						category=LogCategory.METADATA, dataset_id=task.dataset_id, user_id=task.user_id, token=token
					),
				)
				raise ProcessingError(str(e), task_type='metadata', task_id=task.id, dataset_id=task.dataset_id)

		# Process cog if requested
		if TaskTypeEnum.cog in task.task_types:
			try:
				logger.info(
					f'processing cog to {settings.processing_path}',
					LogContext(category=LogCategory.COG, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
				)
				process_cog(task, settings.processing_path)
			except Exception as e:
				logger.error(
					f'COG processing failed: {str(e)}',
					LogContext(category=LogCategory.COG, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
				)
				raise ProcessingError(str(e), task_type='cog', task_id=task.id, dataset_id=task.dataset_id)

		# Process thumbnail if requested
		if TaskTypeEnum.thumbnail in task.task_types:
			try:
				logger.info(
					f'processing thumbnail to {settings.processing_path}',
					LogContext(
						category=LogCategory.THUMBNAIL, dataset_id=task.dataset_id, user_id=task.user_id, token=token
					),
				)
				process_thumbnail(task, settings.processing_path)
			except Exception as e:
				logger.error(
					f'Thumbnail processing failed: {str(e)}',
					LogContext(
						category=LogCategory.THUMBNAIL, dataset_id=task.dataset_id, user_id=task.user_id, token=token
					),
				)
				raise ProcessingError(str(e), task_type='thumbnail', task_id=task.id, dataset_id=task.dataset_id)

		# Process deadwood_segmentation if requested
		if TaskTypeEnum.deadwood in task.task_types:
			try:
				logger.info(
					'processing deadwood segmentation',
					LogContext(
						category=LogCategory.DEADWOOD, dataset_id=task.dataset_id, user_id=task.user_id, token=token
					),
				)
				process_deadwood_segmentation(task, token, settings.processing_path)
			except Exception as e:
				logger.error(
					f'Deadwood segmentation failed: {str(e)}',
					LogContext(
						category=LogCategory.DEADWOOD, dataset_id=task.dataset_id, user_id=task.user_id, token=token
					),
				)
				raise ProcessingError(
					str(e), task_type='deadwood_segmentation', task_id=task.id, dataset_id=task.dataset_id
				)

		# Process treecover_segmentation if requested (runs after deadwood)
		if TaskTypeEnum.treecover in task.task_types:
			try:
				logger.info(
					'processing tree cover segmentation',
					LogContext(
						category=LogCategory.TREECOVER, dataset_id=task.dataset_id, user_id=task.user_id, token=token
					),
				)
				process_treecover_segmentation(task, token, settings.processing_path)
			except Exception as e:
				logger.error(
					f'Tree cover segmentation failed: {str(e)}',
					LogContext(
						category=LogCategory.TREECOVER, dataset_id=task.dataset_id, user_id=task.user_id, token=token
					),
				)
				raise ProcessingError(
					str(e), task_type='treecover_segmentation', task_id=task.id, dataset_id=task.dataset_id
				)

		# Only delete task if all processing completed successfully
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		with use_client(token) as client:
			client.table(settings.queue_table).delete().eq('id', task.id).execute()

	except Exception as e:
		logger.error(
			f'Processing failed: {str(e)}',
			LogContext(category=LogCategory.PROCESS, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
		)
		raise  # Re-raise the exception to ensure the error is properly handled

	finally:
		# Clean up processing path regardless of success/failure
		if not settings.DEV_MODE:
			shutil.rmtree(settings.processing_path, ignore_errors=True)


def background_process():
	"""
	This process checks if there is anything to do in the queue.
	If so, it checks the currently running tasks against the maximum allowed tasks.
	If another task can be started, it will do so. It will skip tasks with errors
	and try the next one.
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
		print('No tasks in the queue.')
		return

	# check if we can start another task
	if num_of_running < settings.CONCURRENT_TASKS:
		# Keep trying tasks until we find one that's ready or run out of tasks
		while True:
			task = get_next_task(token)
			if task is None:
				break

			is_ready = is_dataset_uploaded_or_processed(task, token)
			if is_ready:
				# Found a valid task, process it
				logger.info(
					f'Start a new background process for queued task: {task}.',
					LogContext(
						category=LogCategory.PROCESS, dataset_id=task.dataset_id, user_id=task.user_id, token=token
					),
				)
				# Mark task as processing to avoid duplicate picks while running
				with use_client(token) as client:
					client.table(settings.queue_table).update({'is_processing': True}).eq('id', task.id).execute()

				try:
					process_task(task, token=token)
				finally:
					# If the task still exists (was not deleted by process_task), reset is_processing to False
					with use_client(token) as client:
						result = client.table(settings.queue_table).select('id').eq('id', task.id).execute()
					if result.data:
						with use_client(token) as client:
							client.table(settings.queue_table).update({'is_processing': False}).eq(
								'id', task.id
							).execute()
				break
			else:
				# Task has error or isn't ready; skip it for now and exit loop to try again later
				logger.info(
					f'Skipping task {task.id} due to dataset status; will retry later',
					LogContext(
						category=LogCategory.PROCESS, dataset_id=task.dataset_id, user_id=task.user_id, token=token
					),
				)
				break
	else:
		# inform no spot available
		logger.debug('No spot available for new task.', LogContext(category=LogCategory.PROCESS, token=token))
		return


if __name__ == '__main__':
	background_process()
