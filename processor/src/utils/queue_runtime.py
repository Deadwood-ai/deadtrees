from datetime import datetime, timezone

from shared.models import QueueTask, TaskTypeEnum
from shared.settings import settings
from shared.db import use_client
from shared.logging import LogCategory, LogContext, UnifiedLogger

logger = UnifiedLogger(__name__)


def get_task_blacklist() -> list[str]:
	"""Return the validated set of task types this worker refuses to run."""
	blacklist = []
	for value in settings.processor_task_blacklist:
		task_type = TaskTypeEnum.from_string(value)
		if task_type is None:
			logger.warning(f'Ignoring unknown task type in PROCESSOR_TASK_BLACKLIST: {value!r}')
			continue
		blacklist.append(task_type.value)
	return blacklist


def get_next_task(token: str, client_factory=None) -> QueueTask | None:
	"""Return the highest-priority waiting task this worker can run."""
	if client_factory is None:
		client_factory = use_client
	blacklist = get_task_blacklist()
	with client_factory(token) as client:
		query = client.table(settings.queue_position_table).select('*')
		if blacklist:
			query = query.not_.overlaps('task_types', blacklist)
		response = query.limit(1).execute()
	if not response.data:
		return None
	return QueueTask(**response.data[0])


def _queue_task_from_raw_row(task_data: dict, current_position: int = -1, estimated_time: float | None = None) -> QueueTask:
	return QueueTask(
		id=task_data['id'],
		dataset_id=task_data['dataset_id'],
		user_id=task_data['user_id'],
		priority=task_data['priority'],
		is_processing=task_data['is_processing'],
		claimed_by=task_data.get('claimed_by'),
		claimed_at=task_data.get('claimed_at'),
		current_position=current_position,
		estimated_time=estimated_time,
		task_types=task_data['task_types'],
	)


def _is_missing_queue_claim_column_error(error: Exception) -> bool:
	message = str(error).lower()
	return ('claimed_by' in message or 'claimed_at' in message) and (
		'column' in message or 'schema cache' in message
	)


def get_active_task(token: str, worker_id: str, client_factory=None, logger_instance=None) -> QueueTask | None:
	"""Return this worker's in-progress row, or adopt a legacy unowned row."""
	if client_factory is None:
		client_factory = use_client
	if logger_instance is None:
		logger_instance = logger
	with client_factory(token) as client:
		try:
			response = (
				client.table(settings.queue_table)
				.select('*')
				.eq('is_processing', True)
				.eq('claimed_by', worker_id)
				.order('priority', desc=True)
				.order('created_at')
				.limit(1)
				.execute()
			)
			if not response.data:
				response = (
					client.table(settings.queue_table)
					.select('*')
					.eq('is_processing', True)
					.is_('claimed_by', 'null')
					.order('priority', desc=True)
					.order('created_at')
					.limit(1)
					.execute()
				)
				if response.data:
					legacy_task = response.data[0]
					response = (
						client.table(settings.queue_table)
						.update({'claimed_by': worker_id, 'claimed_at': datetime.now(timezone.utc).isoformat()})
						.eq('id', legacy_task['id'])
						.eq('is_processing', True)
						.is_('claimed_by', 'null')
						.execute()
					)
		except Exception as e:
			if not _is_missing_queue_claim_column_error(e):
				raise
			logger_instance.warning('Queue claim columns are not available yet; falling back to legacy active-task recovery')
			response = (
				client.table(settings.queue_table)
				.select('*')
				.eq('is_processing', True)
				.order('priority', desc=True)
				.order('created_at')
				.limit(1)
				.execute()
			)
	if not response.data:
		return None

	return _queue_task_from_raw_row(response.data[0])


def claim_task(token: str, task: QueueTask, worker_id: str, client_factory=None, logger_instance=None) -> QueueTask | None:
	"""Atomically claim a waiting queue row for this processor worker."""
	if client_factory is None:
		client_factory = use_client
	if logger_instance is None:
		logger_instance = logger
	claimed_at = datetime.now(timezone.utc).isoformat()
	payload = {
		'is_processing': True,
		'claimed_by': worker_id,
		'claimed_at': claimed_at,
	}

	with client_factory(token) as client:
		try:
			response = (
				client.table(settings.queue_table)
				.update(payload)
				.eq('id', task.id)
				.eq('is_processing', False)
				.is_('claimed_by', 'null')
				.execute()
			)
		except Exception as e:
			if not _is_missing_queue_claim_column_error(e):
				raise
			logger_instance.warning('Queue claim columns are not available yet; falling back to legacy queue claim')
			response = (
				client.table(settings.queue_table)
				.update({'is_processing': True})
				.eq('id', task.id)
				.eq('is_processing', False)
				.execute()
			)

	if not response.data:
		return None

	return _queue_task_from_raw_row(
		response.data[0],
		current_position=task.current_position,
		estimated_time=task.estimated_time,
	)


def _apply_queue_owner_filter(query, task: QueueTask):
	if task.claimed_by:
		return query.eq('claimed_by', task.claimed_by)
	return query


def delete_queue_task(token: str, task: QueueTask, client_factory=None) -> None:
	if client_factory is None:
		client_factory = use_client
	with client_factory(token) as client:
		query = client.table(settings.queue_table).delete().eq('id', task.id)
		_apply_queue_owner_filter(query, task).execute()


def release_queue_task(token: str, task: QueueTask, client_factory=None) -> None:
	if client_factory is None:
		client_factory = use_client
	with client_factory(token) as client:
		query = (
			client.table(settings.queue_table)
			.update({'is_processing': False, 'claimed_by': None, 'claimed_at': None})
			.eq('id', task.id)
		)
		try:
			_apply_queue_owner_filter(query, task).execute()
		except Exception as e:
			if not _is_missing_queue_claim_column_error(e):
				raise
			client.table(settings.queue_table).update({'is_processing': False}).eq('id', task.id).execute()


def log_claim_skip(task: QueueTask, token: str, worker_id: str | None = None) -> None:
	reason = f'another worker claimed it first'
	if worker_id is not None:
		reason = f'worker {worker_id} already owns the active row'
	logger.info(
		f'Skipping queue task {task.id}; {reason}',
		LogContext(category=LogCategory.PROCESS, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
	)
