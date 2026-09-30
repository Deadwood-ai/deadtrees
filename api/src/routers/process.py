from typing import Optional, Annotated, List
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, Field

from shared.db import verify_token, use_client, use_service_client
from shared.settings import settings
from shared.models import TaskPayload, QueueTask, TaskTypeEnum
from shared.processing_tasks import downstream_tasks_missing_geotiff, format_missing_geotiff_error
from shared.retry import retry_on_transient_error
from shared.logging import LogContext, LogCategory, UnifiedLogger, SupabaseHandler

# create the router for the processing
router = APIRouter()

# create the OAuth2 password scheme for supabase login
oauth2_scheme = OAuth2PasswordBearer(tokenUrl='token')

# Create logger instance
logger = UnifiedLogger(__name__)
# Add Supabase handler
logger.add_supabase_handler(SupabaseHandler())


_TASK_TYPE_STATUS_FLAGS = {
	TaskTypeEnum.odm_processing: ('is_odm_done',),
	TaskTypeEnum.geotiff: ('is_ortho_done',),
	TaskTypeEnum.metadata: ('is_metadata_done',),
	TaskTypeEnum.cog: ('is_cog_done',),
	TaskTypeEnum.thumbnail: ('is_thumbnail_done',),
	TaskTypeEnum.deadwood_v1: ('is_deadwood_done',),
	TaskTypeEnum.treecover_v1: ('is_forest_cover_done',),
	TaskTypeEnum.deadwood_treecover_combined_v2: ('is_combined_model_done',),
	TaskTypeEnum.aoi_v1: ('is_aoi_done',),
	TaskTypeEnum.embeddings_v1: ('is_embeddings_done',),
	TaskTypeEnum.doy_estimation_v1: ('is_doy_estimation_done',),
}


def _task_type_to_status_flags(task_type: TaskTypeEnum) -> tuple[str, ...]:
	return _TASK_TYPE_STATUS_FLAGS.get(task_type, ())


def _failed_requeue_reset_fields(task_types: list[TaskTypeEnum]) -> dict:
	reset_fields = {
		'has_error': False,
		'error_message': None,
		'error_stage': None,
		'current_status': 'idle',
	}
	for task_type in task_types:
		for flag in _task_type_to_status_flags(task_type):
			reset_fields[flag] = False
	return reset_fields


def _reset_failed_status_for_requeue(service_client, dataset_id: int, task_types: list[TaskTypeEnum]) -> None:
	reset_fields = _failed_requeue_reset_fields(task_types)
	response = (
		service_client.table(settings.statuses_table)
		.update(reset_fields)
		.eq('dataset_id', dataset_id)
		.execute()
	)
	updated_rows = getattr(response, 'data', None) or []
	if len(updated_rows) != 1:
		raise HTTPException(
			status_code=500,
			detail=(
				f'Failed to clear error state for dataset {dataset_id}: '
				f'expected exactly one status row update, got {len(updated_rows)}.'
			),
		)


class ProcessRequest(BaseModel):
	task_types: List[str] = Field(
		description=(
			'Processing stages to enqueue. Include geotiff before model prediction stages '
			'when rerunning predictions on an existing dataset so the standardized ortho is refreshed. '
			'Use deadwood_v1, treecover_v1, and deadwood_treecover_combined_v2 together when comparing old and new models.'
		)
	)
	priority: Optional[int] = Field(default=2, ge=1, le=5, description='Task priority (5=highest, 1=lowest)')


@router.put('/datasets/{dataset_id}/process')
def create_processing_task(
	dataset_id: int,
	token: Annotated[str, Depends(oauth2_scheme)],
	request: ProcessRequest,
):
	# Verify the token
	user = verify_token(token)
	if not user:
		logger.warning('Invalid token attempt', LogContext(category=LogCategory.AUTH, token=token))
		raise HTTPException(status_code=401, detail='Invalid token')

	# Log process request
	logger.info(
		f'Processing request received for dataset {dataset_id}',
		LogContext(
			category=LogCategory.ADD_PROCESS,
			user_id=user.id,
			dataset_id=dataset_id,
			token=token,
			extra={'task_types': request.task_types},
		),
	)

	# Validate task_types
	if not request.task_types:
		logger.warning(
			'Empty task types list provided',
			LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token),
		)
		raise HTTPException(status_code=400, detail='At least one task type must be specified')

	try:
		validated_task_types = [TaskTypeEnum(t) for t in request.task_types]
	except ValueError as e:
		logger.warning(
			f'Invalid task type provided: {str(e)}',
			LogContext(
				category=LogCategory.ADD_PROCESS,
				user_id=user.id,
				dataset_id=dataset_id,
				token=token,
				extra={'invalid_task_types': request.task_types},
			),
		)
		raise HTTPException(status_code=400, detail=f'Invalid task type: {str(e)}')

	downstream_without_geotiff = downstream_tasks_missing_geotiff(validated_task_types)
	if downstream_without_geotiff:
		detail = format_missing_geotiff_error(downstream_without_geotiff)
		logger.warning(
			'Rejected processing request missing geotiff dependency',
			LogContext(
				category=LogCategory.ADD_PROCESS,
				user_id=user.id,
				dataset_id=dataset_id,
				token=token,
				extra={
					'task_types': request.task_types,
					'missing_geotiff_for': [task_type.value for task_type in downstream_without_geotiff],
				},
			),
		)
		raise HTTPException(status_code=400, detail=detail)

	# Load the dataset info with the caller's token before any privileged write.
	try:
		with use_client(token) as client:
			response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()
			if not response.data:
				logger.warning(
					f'Dataset not found: {dataset_id}',
					LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token),
				)
				raise HTTPException(status_code=404, detail=f'Dataset <ID={dataset_id}> not found.')
			dataset = response.data[0]
			is_owner = str(dataset['user_id']) == str(user.id)
			is_privileged = bool(client.rpc('can_view_all_private_data').execute().data) if not is_owner else False
			if not is_owner and not is_privileged:
				raise HTTPException(status_code=403, detail='Only the dataset owner or a privileged user can process it.')
	except HTTPException:
		raise
	except Exception as e:
		msg = f'Error loading dataset {dataset_id}: {str(e)}'
		logger.error(
			msg, LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token)
		)
		raise HTTPException(status_code=500, detail=msg)

	# Check if dataset is currently being processed and clean up old queue items.
	# The reads are idempotent and the reset/delete are safe to repeat, so the
	# whole block is retried on a transient DB blip. The internal 409s are not
	# transient, so they propagate immediately instead of being retried.
	@retry_on_transient_error
	def _check_and_clean_queue() -> None:
		with use_client(token) as client:
			# If the processor already picked up a task, block reruns.
			# This is more robust than relying solely on v2_statuses.current_status, which may lag.
			active_queue = (
				client.table(settings.queue_table)
				.select('id')
				.eq('dataset_id', dataset_id)
				.eq('is_processing', True)
				.execute()
			)
			if active_queue.data:
				raise HTTPException(
					status_code=409,
					detail=(
						f'Dataset {dataset_id} is currently being processed. '
						'Please stop the active processing container (or wait for completion), then retry.'
					),
				)

			status_check = (
				client.table(settings.statuses_table)
				.select('current_status, has_error')
				.eq('dataset_id', dataset_id)
				.execute()
			)

			if status_check.data:
				s = status_check.data[0]
				if s['current_status'] != 'idle' and not s.get('has_error', False):
					logger.warning(
						f'Dataset {dataset_id} is currently being processed',
						LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token),
					)
					raise HTTPException(
						status_code=409,
						detail=f'Dataset {dataset_id} is currently being processed. Please wait for processing to complete, then retry.',
					)

				if s.get('has_error', False):
					with use_service_client() as service_client:
						_reset_failed_status_for_requeue(service_client, dataset_id, validated_task_types)
					logger.info(
						f'Cleared error state for dataset {dataset_id} (requeue)',
						LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token),
					)

			# Check for existing queue items and delete them (users can delete their own items)
			existing_tasks = client.table(settings.queue_table).select('id').eq('dataset_id', dataset_id).execute()

			if existing_tasks.data:
				# Delete all existing queue items for this dataset (clean slate for rerun)
				client.table(settings.queue_table).delete().eq('dataset_id', dataset_id).execute()
				logger.info(
					f'Removed {len(existing_tasks.data)} existing queue items for dataset {dataset_id}',
					LogContext(
						category=LogCategory.ADD_PROCESS,
						user_id=user.id,
						dataset_id=dataset_id,
						token=token,
						extra={'removed_count': len(existing_tasks.data)},
					),
				)

	try:
		_check_and_clean_queue()
	except HTTPException:
		raise
	except Exception as e:
		msg = f'Error checking queue status for dataset {dataset_id}: {str(e)}'
		logger.error(
			msg, LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token)
		)
		raise HTTPException(status_code=500, detail=msg)

	# Create the task payload
	payload = TaskPayload(
		dataset_id=dataset_id,
		user_id=user.id,
		task_types=validated_task_types,
		priority=request.priority,
		is_processing=False,
	)

	def _sync_aoi_requirement() -> None:
		with use_service_client() as service_client:
			current_status_response = (
				service_client.table(settings.statuses_table)
				.select('is_aoi_required')
				.eq('dataset_id', dataset_id)
				.execute()
			)
			current_status_rows = getattr(current_status_response, 'data', None) or []
			if len(current_status_rows) > 1:
				raise HTTPException(
					status_code=500,
					detail=(
						f'Failed to load AOI requirement for dataset {dataset_id}: '
						f'expected at most one status row, got {len(current_status_rows)}.'
					),
				)

			is_aoi_required = (
				TaskTypeEnum.aoi_v1 in validated_task_types
				or bool(current_status_rows and current_status_rows[0].get('is_aoi_required'))
			)
			if current_status_rows:
				status_response = (
					service_client.table(settings.statuses_table)
					.update({'is_aoi_required': is_aoi_required})
					.eq('dataset_id', dataset_id)
					.execute()
				)
				updated_rows = getattr(status_response, 'data', None) or []
				if len(updated_rows) != 1:
					raise HTTPException(
						status_code=500,
						detail=(
							f'Failed to update AOI requirement for dataset {dataset_id}: '
							f'expected exactly one status row update, got {len(updated_rows)}.'
						),
					)
			elif is_aoi_required:
				service_client.table(settings.statuses_table).insert(
					{'dataset_id': dataset_id, 'is_aoi_required': True}
				).execute()

	try:
		_sync_aoi_requirement()
	except HTTPException:
		raise
	except Exception as e:
		msg = f'Error updating AOI requirement for dataset {dataset_id}: {str(e)}'
		logger.error(
			msg, LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token)
		)
		raise HTTPException(status_code=500, detail=msg)

	# Add the task to the queue. The cleanup above removed any existing rows for
	# this dataset, so if a transient failure drops the connection after the
	# insert committed, we can detect the row already exists and re-read it
	# instead of inserting a duplicate task.
	def _task_already_inserted() -> bool:
		with use_client(token) as client:
			existing = client.table(settings.queue_table).select('id').eq('dataset_id', dataset_id).execute()
			return bool(existing.data)

	@retry_on_transient_error(verify_succeeded=_task_already_inserted)
	def _insert_task() -> Optional[dict]:
		with use_client(token) as client:
			send_data = {k: v for k, v in payload.model_dump().items() if v is not None and k != 'id'}
			response = client.table(settings.queue_table).insert(send_data).execute()
			return response.data[0]

	try:
		inserted = _insert_task()
		if inserted is None:
			# Insert committed but the response was lost; re-read the queued row.
			with use_client(token) as client:
				existing = client.table(settings.queue_table).select('*').eq('dataset_id', dataset_id).execute()
				inserted = existing.data[0]
		task = TaskPayload(**inserted)

		logger.info(
			f'Added task to queue for dataset {dataset_id}',
			LogContext(
				category=LogCategory.ADD_PROCESS,
				user_id=user.id,
				dataset_id=dataset_id,
				token=token,
				extra={
					'task_id': task.id,
					'task_types': request.task_types,
					'priority': request.priority,  # Add priority to logging
				},
			),
		)

	except Exception as e:
		msg = f'Error adding task to queue: {str(e)}'
		logger.error(
			msg,
			LogContext(
				category=LogCategory.ADD_PROCESS,
				user_id=user.id,
				dataset_id=dataset_id,
				token=token,
				extra={'priority': request.priority},  # Add priority to error logging
			),
		)
		raise HTTPException(status_code=500, detail=msg)

	# Load the current position assigned to this task
	try:
		with use_client(token) as client:
			response = client.table(settings.queue_position_table).select('*').eq('id', task.id).execute()
			if response.data:
				task_data = response.data[0]
				task_data['estimated_time'] = task_data.get('estimated_time') or 0.0
				task = QueueTask(**task_data)
				logger.info(
					f'Task position loaded for task {task.id}',
					LogContext(
						category=LogCategory.ADD_PROCESS,
						user_id=user.id,
						dataset_id=dataset_id,
						token=token,
						extra={'position': task.current_position, 'estimated_time': task.estimated_time},
					),
				)
				return task
			else:
				logger.warning(
					f'No task position found for task {task.id}',
					LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token),
				)
				task = QueueTask(
					id=task.id,
					dataset_id=dataset_id,
					user_id=user.id,
					priority=2,
					is_processing=False,
					current_position=-1,
					estimated_time=0.0,
					task_types=validated_task_types,
				)
				return task

	except Exception as e:
		msg = f'Error loading task position: {str(e)}'
		logger.error(
			msg, LogContext(category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token)
		)
		raise HTTPException(status_code=500, detail=msg)
