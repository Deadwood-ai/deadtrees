from typing import Optional, Annotated, List
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from postgrest.exceptions import APIError
from pydantic import BaseModel, Field

from shared.db import verify_token, use_client
from shared.settings import settings
from shared.models import QueueTask, TaskTypeEnum, DEFAULT_QUEUE_PRIORITY
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


# SQLSTATEs raised by public.requeue_dataset_processing, mapped to HTTP statuses.
_REQUEUE_ERROR_STATUS = {
	'22023': 400,  # invalid task type or priority
	'42501': 403,  # not the owner or a privileged user
	'P0002': 404,  # dataset missing or hidden from the caller
	'55006': 409,  # dataset is being processed
}


class ProcessRequest(BaseModel):
	task_types: List[str] = Field(
		description=(
			'Processing stages to enqueue. Include geotiff before model prediction stages '
			'when rerunning predictions on an existing dataset so the standardized ortho is refreshed. '
			'Use deadwood_v1, treecover_v1, and deadwood_treecover_combined_v2 together when comparing old and new models.'
		)
	)
	priority: Optional[int] = Field(
		default=DEFAULT_QUEUE_PRIORITY, ge=1, le=5, description='Task priority (5=highest, 1=lowest)'
	)


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

	def log_context(**extra) -> LogContext:
		return LogContext(
			category=LogCategory.ADD_PROCESS, user_id=user.id, dataset_id=dataset_id, token=token, extra=extra or None
		)

	logger.info(f'Processing request received for dataset {dataset_id}', log_context(task_types=request.task_types))

	# Validate task_types
	if not request.task_types:
		logger.warning('Empty task types list provided', log_context())
		raise HTTPException(status_code=400, detail='At least one task type must be specified')

	try:
		validated_task_types = [TaskTypeEnum(t) for t in request.task_types]
	except ValueError as e:
		logger.warning(f'Invalid task type provided: {str(e)}', log_context(invalid_task_types=request.task_types))
		raise HTTPException(status_code=400, detail=f'Invalid task type: {str(e)}')

	downstream_without_geotiff = downstream_tasks_missing_geotiff(validated_task_types)
	if downstream_without_geotiff:
		detail = format_missing_geotiff_error(downstream_without_geotiff)
		logger.warning(
			'Rejected processing request missing geotiff dependency',
			log_context(
				task_types=request.task_types,
				missing_geotiff_for=[task_type.value for task_type in downstream_without_geotiff],
			),
		)
		raise HTTPException(status_code=400, detail=detail)

	# The RPC authorizes the caller, rejects active processing, replaces waiting
	# queue rows, resets a failed status and inserts the task in one transaction.
	# Repeating it is safe: a retry replaces the row an earlier attempt committed.
	@retry_on_transient_error
	def _requeue() -> dict:
		with use_client(token) as client:
			response = client.rpc(
				'requeue_dataset_processing',
				{
					'p_dataset_id': dataset_id,
					'p_task_types': [task_type.value for task_type in validated_task_types],
					'p_priority': request.priority,
				},
			).execute()
			return response.data

	try:
		inserted = _requeue()
	except APIError as e:
		status_code = _REQUEUE_ERROR_STATUS.get(e.code)
		if status_code is None:
			msg = f'Error adding task to queue: {e.message}'
			logger.error(msg, log_context(priority=request.priority))
			raise HTTPException(status_code=500, detail=msg)
		logger.warning(f'Rejected processing request: {e.message}', log_context(task_types=request.task_types))
		raise HTTPException(status_code=status_code, detail=e.message)
	except Exception as e:
		msg = f'Error adding task to queue: {str(e)}'
		logger.error(msg, log_context(priority=request.priority))
		raise HTTPException(status_code=500, detail=msg)

	task_id = inserted['id']
	logger.info(
		f'Added task to queue for dataset {dataset_id}',
		log_context(task_id=task_id, task_types=request.task_types, priority=request.priority),
	)

	# Load the current position assigned to this task
	try:
		with use_client(token) as client:
			response = client.table(settings.queue_position_table).select('*').eq('id', task_id).execute()
	except Exception as e:
		msg = f'Error loading task position: {str(e)}'
		logger.error(msg, log_context())
		raise HTTPException(status_code=500, detail=msg)

	if not response.data:
		logger.warning(f'No task position found for task {task_id}', log_context())
		return QueueTask(**inserted, current_position=-1, estimated_time=0.0)

	task_data = response.data[0]
	task_data['estimated_time'] = task_data.get('estimated_time') or 0.0
	task = QueueTask(**task_data)
	logger.info(
		f'Task position loaded for task {task.id}',
		log_context(position=task.current_position, estimated_time=task.estimated_time),
	)
	return task
