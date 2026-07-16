from shared.logging import LogCategory, LogContext, SupabaseHandler, UnifiedLogger
from shared.models import QueueTask
from shared.notifications.processing import (
	ProcessingNotificationType,
	dispatch_processing_result,
	reconcile_processing_notifications,
	record_processing_result,
)


logger = UnifiedLogger(__name__)
logger.add_supabase_handler(SupabaseHandler())


def notify_processing_result_safely(
	task: QueueTask,
	event_type: ProcessingNotificationType,
	token: str,
) -> list[dict]:
	"""Persist the outbox event, then attempt delivery without risking queue state."""
	batch = record_processing_result(task, event_type)
	if batch.events:
		logger.info(
			f'Recorded {len(batch.events)} {event_type.value} notification event(s) for task {task.id}',
			LogContext(
				category=LogCategory.PROCESS,
				dataset_id=task.dataset_id,
				user_id=task.user_id,
				token=token,
			),
		)

	try:
		return dispatch_processing_result(batch)
	except Exception as notification_error:
		logger.warning(
			f'Failed to dispatch {event_type.value} notifications for task {task.id}: {notification_error}',
			LogContext(
				category=LogCategory.PROCESS,
				dataset_id=task.dataset_id,
				user_id=task.user_id,
				token=token,
			),
		)
		return batch.events


def reconcile_processing_notifications_safely() -> None:
	"""Retry durable notification events without blocking processor work."""
	try:
		events = reconcile_processing_notifications(limit=1)
		if events:
			logger.info(f'Reconciled {len(events)} processing notification event(s)')
	except Exception as notification_error:
		logger.warning(f'Failed to reconcile processing notifications: {notification_error}')
