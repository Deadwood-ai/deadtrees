import shutil
from pathlib import Path
from processor.src.process_geotiff import process_geotiff
from processor.src.process_odm import process_odm
from shared.models import QueueTask, TaskTypeEnum, StatusEnum
from shared.settings import settings
from shared.db import use_client, login, verify_token
from shared.status import update_status
from .process_thumbnail import process_thumbnail
from .process_cog import process_cog
from .process_deadwood_segmentation import process_deadwood_segmentation
from .process_treecover_segmentation import process_treecover_segmentation
from .process_metadata import process_metadata
from .exceptions import AuthenticationError, ProcessingError
from .utils.linear_issues import create_processing_failure_issue
from shared.logging import LogContext, LogCategory, UnifiedLogger, SupabaseHandler

# Initialize logger with proper cleanup
logger = UnifiedLogger(__name__)
logger.add_supabase_handler(SupabaseHandler())


# Maps each task type to its corresponding is_*_done flag and human-readable stage name.
# Used by crash detection to determine exactly which stage a previous run crashed during.
PIPELINE_STAGE_MAP = [
	(TaskTypeEnum.odm_processing, 'is_odm_done', 'odm_processing'),
	(TaskTypeEnum.geotiff, 'is_ortho_done', 'ortho_processing'),
	(TaskTypeEnum.metadata, 'is_metadata_done', 'metadata_processing'),
	(TaskTypeEnum.cog, 'is_cog_done', 'cog_processing'),
	(TaskTypeEnum.thumbnail, 'is_thumbnail_done', 'thumbnail_processing'),
	(TaskTypeEnum.deadwood, 'is_deadwood_done', 'deadwood_segmentation'),
	(TaskTypeEnum.treecover, 'is_forest_cover_done', 'forest_cover_segmentation'),
]


def detect_crashed_stage(status_data: dict, task_types: list) -> str:
	"""Determine which pipeline stage a previous crash occurred during.

	Walks the pipeline in order and returns the first stage that was requested
	but not yet marked as done in v2_statuses.

	Args:
		status_data: Row from v2_statuses table
		task_types: List of TaskTypeEnum values from the queue task

	Returns:
		str: Human-readable stage name where the crash occurred
	"""
	for task_type, done_flag, stage_name in PIPELINE_STAGE_MAP:
		if task_type in task_types and not status_data.get(done_flag, False):
			return stage_name
	return 'unknown'


def get_completed_stages(status_data: dict) -> list[str]:
	"""Get list of pipeline stages that completed successfully before the crash.

	Args:
		status_data: Row from v2_statuses table

	Returns:
		list[str]: Human-readable names of completed stages
	"""
	completed = []
	for _, done_flag, stage_name in PIPELINE_STAGE_MAP:
		if status_data.get(done_flag, False):
			completed.append(stage_name)
	return completed



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


def is_dataset_uploaded_or_processed(task: QueueTask, token: str) -> tuple:
	"""Check if a dataset is ready for processing by verifying its upload status and error status.

	Args:
	    task (QueueTask): The task to check
	    token (str): Authentication token

	Returns:
	    tuple: (is_ready: bool, has_error: bool)
	        - is_ready: True if dataset is uploaded and ready for processing
	        - has_error: True if dataset has errors (should be removed from queue)
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
			return False, False

		is_uploaded = response.data[0]['is_upload_done']
		has_error = response.data[0].get('has_error', False)  # Default to False if field doesn't exist

		if has_error:
			logger.warning(
				f'Dataset {task.dataset_id} has errors, will remove from queue',
				extra={'token': token, 'dataset_id': task.dataset_id},
			)
			return False, True

		msg = f'dataset upload status: {is_uploaded}'
		logger.info(msg, extra={'token': token})

		return is_uploaded, False


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

		# Create Linear issue for processing failure
		try:
			stage = e.task_type if isinstance(e, ProcessingError) else 'processing'
			create_processing_failure_issue(
				token=token,
				dataset_id=task.dataset_id,
				stage=stage,
				error_message=str(e),
			)
		except Exception as linear_error:
			# Never let Linear issue creation block processing
			logger.warning(f'Failed to create Linear issue: {linear_error}')

		# Delete task from queue on failure - error is already recorded in status table
		try:
			delete_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
			with use_client(delete_token) as client:
				client.table(settings.queue_table).delete().eq('id', task.id).execute()
			logger.info(
				f'Removed failed task {task.id} from queue',
				LogContext(category=LogCategory.PROCESS, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
			)
		except Exception as delete_error:
			logger.error(
				f'Failed to remove task {task.id} from queue: {delete_error}',
				LogContext(category=LogCategory.PROCESS, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
			)
		raise  # Re-raise the exception to ensure the error is properly handled

	finally:
		# Clean up processing path regardless of success/failure
		if not settings.DEV_MODE:
			shutil.rmtree(settings.processing_path, ignore_errors=True)


def background_process():
	"""
	Cron-triggered processor: pick the next task from the queue and process it.

	On each run this function:
	1. Logs in as the processor service account.
	2. Loops through the queue, clearing any crashed tasks it finds:
	   - A "crash" is detected when current_status != 'idle' for a queued task,
	     meaning a previous container run died (OOM, kill) mid-processing.
	   - Crashed tasks are marked as errored, a Linear issue is created, and
	     the task is removed from the queue.
	3. Once a healthy, ready task is found, processes it and exits.

	docker compose up guarantees only one processor container runs at a time,
	so no is_processing flag or concurrency guard is needed.
	"""
	# use the processor to log in
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
	user = verify_token(token)
	if not user:
		# Token verification failed, try fresh login without cache
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)
		user = verify_token(token)
		if not user:
			raise Exception(status_code=401, detail='Invalid token after fresh login')

	while True:
		task = get_next_task(token)
		if task is None:
			print('No tasks in the queue.')
			return

		is_ready, has_error = is_dataset_uploaded_or_processed(task, token)

		if has_error:
			# Dataset already has errors - remove task from queue
			logger.info(
				f'Removing errored task {task.id} for dataset {task.dataset_id} from queue',
				LogContext(
					category=LogCategory.PROCESS, dataset_id=task.dataset_id, user_id=task.user_id, token=token
				),
			)
			with use_client(token) as client:
				client.table(settings.queue_table).delete().eq('id', task.id).execute()
			continue

		if not is_ready:
			# Not uploaded yet - skip, try again next cron run
			logger.info(
				f'Skipping task {task.id} - dataset not uploaded yet; will retry later',
				LogContext(
					category=LogCategory.PROCESS, dataset_id=task.dataset_id, user_id=task.user_id, token=token
				),
			)
			return

		# CRASH DETECTION: check if a previous run crashed mid-processing
		with use_client(token) as client:
			status_resp = client.table(settings.statuses_table) \
				.select('*').eq('dataset_id', task.dataset_id).execute()

		if status_resp.data:
			status = status_resp.data[0]
			if status['current_status'] != 'idle':
				# Previous crash detected - current_status is still set to a processing stage
				crashed_stage = detect_crashed_stage(status, task.task_types)
				completed = get_completed_stages(status)
				error_msg = f'Processing container crashed during {crashed_stage}. Completed: {completed}'

				logger.warning(
					f'Crash detected for dataset {task.dataset_id}: {error_msg}',
					LogContext(
						category=LogCategory.PROCESS, dataset_id=task.dataset_id, user_id=task.user_id, token=token
					),
				)

				# Mark as errored and reset to idle so it can be re-queued later
				update_status(
					token,
					dataset_id=task.dataset_id,
					current_status=StatusEnum.idle,
					has_error=True,
					error_message=error_msg,
				)

				# Create Linear issue for visibility
				try:
					create_processing_failure_issue(
						token=token,
						dataset_id=task.dataset_id,
						stage=crashed_stage,
						error_message=error_msg,
					)
				except Exception as linear_error:
					logger.warning(f'Failed to create Linear issue for crash: {linear_error}')

				# Remove from queue
				with use_client(token) as client:
					client.table(settings.queue_table).delete().eq('id', task.id).execute()
				continue  # check next task in queue

		# Normal processing - found a healthy, ready task
		logger.info(
			f'Start processing queued task: {task}.',
			LogContext(
				category=LogCategory.PROCESS, dataset_id=task.dataset_id, user_id=task.user_id, token=token
			),
		)
		process_task(task, token=token)
		break  # processed one task, exit for cron


if __name__ == '__main__':
	background_process()
