from datetime import datetime, timedelta, timezone
from dataclasses import dataclass
from enum import Enum
from typing import Any

from shared.db import use_service_client
from shared.models import QueueTask
from shared.notifications.email import send_email
from shared.notifications.templates import (
	dataset_completed_email,
	dataset_failed_email,
	processing_failure_holiday_note_is_active,
)
from shared.settings import settings


class ProcessingNotificationType(str, Enum):
	completed = 'processing_completed'
	failed = 'processing_failed'


@dataclass(frozen=True)
class ProcessingNotificationBatch:
	events: list[dict[str, Any]]
	file_name: str


STATUS_SNAPSHOT_FIELDS = (
	'current_status',
	'is_upload_done',
	'is_odm_done',
	'is_ortho_done',
	'is_metadata_done',
	'is_cog_done',
	'is_thumbnail_done',
	'is_deadwood_done',
	'is_forest_cover_done',
	'is_combined_model_done',
	'is_aoi_done',
	'is_aoi_required',
	'has_error',
)

MAX_DELIVERY_ATTEMPTS = 3
SENDING_STALE_AFTER = timedelta(minutes=10)
DELIVERY_RETRY_DELAYS = (timedelta(minutes=5), timedelta(minutes=30))


def _next_attempt_at(delivery_attempts: int) -> str | None:
	if delivery_attempts >= MAX_DELIVERY_ATTEMPTS:
		return None
	delay_index = min(max(delivery_attempts - 1, 0), len(DELIVERY_RETRY_DELAYS) - 1)
	return (datetime.now(timezone.utc) + DELIVERY_RETRY_DELAYS[delay_index]).isoformat()


def is_dataset_user_visible_ready(status: dict[str, Any], file_name: str) -> bool:
	"""Match the user-visible completion rule used by the frontend notification."""
	is_odm_workflow = file_name.lower().endswith('.zip')
	predictions_done = (
		bool(status.get('is_combined_model_done'))
		or bool(status.get('is_deadwood_done') and status.get('is_forest_cover_done'))
	)
	current_status = status.get('current_status')

	return bool(
		not status.get('has_error')
		and (not current_status or current_status == 'idle')
		and status.get('is_upload_done')
		and (not is_odm_workflow or status.get('is_odm_done'))
		and status.get('is_ortho_done')
		and status.get('is_metadata_done')
		and status.get('is_cog_done')
		and status.get('is_thumbnail_done')
		and predictions_done
		and (not status.get('is_aoi_required') or status.get('is_aoi_done'))
	)


def build_recipient_roles(owner_user_id: str, requester_user_id: str) -> dict[str, list[str]]:
	recipients: dict[str, list[str]] = {owner_user_id: ['owner']}
	recipients.setdefault(requester_user_id, []).append('requester')
	return recipients


def _requester_is_authorized(client, owner_user_id: str, requester_user_id: str) -> bool:
	if requester_user_id == owner_user_id:
		return True
	response = (
		client.table('privileged_users')
		.select('user_id')
		.eq('user_id', requester_user_id)
		.eq('can_view_all_private', True)
		.limit(1)
		.execute()
	)
	return bool(response.data)


def _get_user_email(client, user_id: str) -> str | None:
	response = client.auth.admin.get_user_by_id(user_id)
	if response and response.user:
		return response.user.email
	return None


def _load_preferences(client, user_ids: list[str]) -> dict[str, bool]:
	response = (
		client.table(settings.notification_preferences_table)
		.select('user_id,processing_emails_enabled')
		.in_('user_id', user_ids)
		.execute()
	)
	return {row['user_id']: bool(row['processing_emails_enabled']) for row in (response.data or [])}


def _event_payloads(
	client,
	task: QueueTask,
	event_type: ProcessingNotificationType,
	owner_user_id: str,
	status: dict[str, Any],
) -> list[dict[str, Any]]:
	recipient_roles = {owner_user_id: ['owner']}
	if _requester_is_authorized(client, owner_user_id, task.user_id):
		recipient_roles.setdefault(task.user_id, []).append('requester')
	preferences = _load_preferences(client, list(recipient_roles))
	task_types = [task_type.value for task_type in task.task_types]
	status_snapshot = {field: status.get(field) for field in STATUS_SNAPSHOT_FIELDS if field in status}
	payloads = []

	for recipient_user_id, roles in recipient_roles.items():
		preference_enabled = preferences.get(recipient_user_id, True)
		recipient_email = None
		event_status = 'pending'
		delivery_error = None
		next_attempt_at = None

		if not preference_enabled:
			event_status = 'skipped'
			delivery_error = 'user_opted_out'
		else:
			try:
				recipient_email = _get_user_email(client, recipient_user_id)
			except Exception:
				event_status = 'failed'
				delivery_error = 'recipient_email_lookup_failed'
				next_attempt_at = _next_attempt_at(0)
			else:
				if not recipient_email:
					event_status = 'skipped'
					delivery_error = 'recipient_email_missing'

		payloads.append(
			{
				'queue_task_id': task.id,
				'dataset_id': task.dataset_id,
				'event_type': event_type.value,
				'recipient_user_id': recipient_user_id,
				'recipient_email': recipient_email,
				'recipient_roles': roles,
				'task_types': task_types,
				'status': event_status,
				'status_snapshot': status_snapshot,
				'delivery_error': delivery_error,
				'next_attempt_at': next_attempt_at,
			}
		)

	return payloads


def _render_event(event_type: ProcessingNotificationType, dataset_id: int, file_name: str):
	if event_type == ProcessingNotificationType.completed:
		return dataset_completed_email(dataset_id, file_name)
	return dataset_failed_email(
		dataset_id,
		file_name,
		include_holiday_note=processing_failure_holiday_note_is_active(
			settings.PROCESSING_FAILURE_EMAIL_HOLIDAY_NOTE_UNTIL
		),
	)


def _claim_event(client, event: dict[str, Any]) -> dict[str, Any] | None:
	status = event['status']
	attempts = int(event.get('delivery_attempts') or 0)
	if status not in {'pending', 'failed', 'sending'} or attempts >= MAX_DELIVERY_ATTEMPTS:
		return None

	now = datetime.now(timezone.utc)
	query = (
		client.table(settings.processing_notification_events_table)
		.update(
			{
				'status': 'sending',
				'delivery_attempts': attempts + 1,
				'next_attempt_at': None,
				'updated_at': now.isoformat(),
			}
		)
		.eq('id', event['id'])
		.eq('status', status)
	)
	if status == 'sending':
		query = query.lt('updated_at', (now - SENDING_STALE_AFTER).isoformat())

	claimed = query.execute()
	return claimed.data[0] if claimed.data else None


def _update_event(client, event_id: str, update: dict[str, Any]) -> dict[str, Any]:
	update['updated_at'] = datetime.now(timezone.utc).isoformat()
	updated = (
		client.table(settings.processing_notification_events_table)
		.update(update)
		.eq('id', event_id)
		.execute()
	)
	return updated.data[0] if updated.data else {'id': event_id, **update}


def _recipient_is_still_authorized(client, event: dict[str, Any]) -> bool:
	dataset = (
		client.table(settings.datasets_table)
		.select('user_id')
		.eq('id', event['dataset_id'])
		.maybe_single()
		.execute()
	)
	return bool(
		dataset
		and dataset.data
		and _requester_is_authorized(client, dataset.data['user_id'], event['recipient_user_id'])
	)


def _dispatch_event(client, event: dict[str, Any], file_name: str) -> dict[str, Any]:
	if not settings.PROCESSING_EMAIL_NOTIFICATIONS_ENABLED:
		return event

	claimed = _claim_event(client, event)
	if not claimed:
		return event

	if not _recipient_is_still_authorized(client, claimed):
		return _update_event(
			client,
			claimed['id'],
			{'status': 'skipped', 'delivery_error': 'recipient_unauthorized', 'next_attempt_at': None},
		)

	preferences = _load_preferences(client, [claimed['recipient_user_id']])
	if not preferences.get(claimed['recipient_user_id'], True):
		return _update_event(
			client,
			claimed['id'],
			{'status': 'skipped', 'delivery_error': 'user_opted_out', 'next_attempt_at': None},
		)

	try:
		recipient_email = _get_user_email(client, claimed['recipient_user_id'])
	except Exception:
		return _update_event(
			client,
			claimed['id'],
			{
				'status': 'failed',
				'delivery_error': 'recipient_email_lookup_failed',
				'next_attempt_at': _next_attempt_at(claimed['delivery_attempts']),
			},
		)
	if not recipient_email:
		return _update_event(
			client,
			claimed['id'],
			{
				'status': 'skipped',
				'delivery_error': 'recipient_email_missing',
				'next_attempt_at': None,
			},
		)
	claimed['recipient_email'] = recipient_email

	event_type = ProcessingNotificationType(claimed['event_type'])
	subject, text_body, html_body = _render_event(event_type, claimed['dataset_id'], file_name)
	result = send_email(
		claimed['recipient_email'],
		subject,
		html_body,
		text_body=text_body,
		idempotency_key=claimed['id'],
	)
	update = {
		'provider': result.get('method'),
		'provider_message_id': result.get('message_id'),
		'recipient_email': claimed['recipient_email'],
	}
	if result.get('success'):
		update.update(
			{
				'status': 'sent',
				'sent_at': datetime.now(timezone.utc).isoformat(),
				'delivery_error': None,
				'next_attempt_at': None,
			}
		)
	else:
		delivery_error = str(result.get('error', 'delivery_failed'))[:500]
		update.update(
			{
				'status': 'failed',
				'delivery_error': delivery_error,
				'next_attempt_at': _next_attempt_at(claimed['delivery_attempts']),
			}
		)

	return _update_event(client, claimed['id'], update)


def reconcile_processing_notifications(limit: int = 25) -> list[dict[str, Any]]:
	"""Retry failed deliveries and reclaim sends interrupted by a worker crash."""
	if not settings.PROCESSING_EMAIL_NOTIFICATIONS_ENABLED:
		return []

	now = datetime.now(timezone.utc)
	stale_before = (now - SENDING_STALE_AFTER).isoformat()
	with use_service_client() as client:
		pending = (
			client.table(settings.processing_notification_events_table)
			.select('*')
			.eq('status', 'pending')
			.order('updated_at')
			.limit(limit)
			.execute()
		)
		remaining = max(0, limit - len(pending.data or []))
		failed = []
		if remaining:
			failed_response = (
				client.table(settings.processing_notification_events_table)
				.select('*')
				.eq('status', 'failed')
				.lt('delivery_attempts', MAX_DELIVERY_ATTEMPTS)
				.lte('next_attempt_at', now.isoformat())
				.order('next_attempt_at')
				.limit(remaining)
				.execute()
			)
			failed = failed_response.data or []
			remaining = max(0, remaining - len(failed))
		stale = []
		if remaining:
			stale_response = (
				client.table(settings.processing_notification_events_table)
				.select('*')
				.eq('status', 'sending')
				.lt('updated_at', stale_before)
				.lt('delivery_attempts', MAX_DELIVERY_ATTEMPTS)
				.order('updated_at')
				.limit(remaining)
				.execute()
			)
			stale = stale_response.data or []

		results = []
		for event in [*(pending.data or []), *failed, *stale]:
			dataset = (
				client.table(settings.datasets_table)
				.select('file_name')
				.eq('id', event['dataset_id'])
				.maybe_single()
				.execute()
			)
			if not dataset or not dataset.data:
				continue
			file_name = dataset.data.get('file_name') or f"dataset_{event['dataset_id']}"
			results.append(_dispatch_event(client, event, file_name))

		exhausted = (
			client.table(settings.processing_notification_events_table)
			.select('id,updated_at')
			.eq('status', 'sending')
			.lt('updated_at', stale_before)
			.gte('delivery_attempts', MAX_DELIVERY_ATTEMPTS)
			.limit(limit)
			.execute()
		)
		for event in exhausted.data or []:
			updated = (
				client.table(settings.processing_notification_events_table)
				.update(
					{
						'status': 'failed',
						'delivery_error': 'delivery_retry_exhausted',
						'updated_at': datetime.now(timezone.utc).isoformat(),
					}
				)
				.eq('id', event['id'])
				.eq('status', 'sending')
				.eq('updated_at', event['updated_at'])
				.execute()
			)
			results.extend(updated.data or [])

		return results


def record_processing_result(
	task: QueueTask,
	event_type: ProcessingNotificationType,
) -> ProcessingNotificationBatch:
	"""Persist at most one processing result event per run and recipient."""
	if not settings.PROCESSING_EMAIL_NOTIFICATIONS_ENABLED:
		return ProcessingNotificationBatch(events=[], file_name=f'dataset_{task.dataset_id}')

	with use_service_client() as client:
		dataset_response = (
			client.table(settings.datasets_table)
			.select('user_id,file_name')
			.eq('id', task.dataset_id)
			.single()
			.execute()
		)
		if not dataset_response.data:
			return ProcessingNotificationBatch(events=[], file_name=f'dataset_{task.dataset_id}')

		status_response = (
			client.table(settings.statuses_table)
			.select(','.join(STATUS_SNAPSHOT_FIELDS))
			.eq('dataset_id', task.dataset_id)
			.maybe_single()
			.execute()
		)
		status = status_response.data if status_response else {}
		file_name = dataset_response.data.get('file_name') or f'dataset_{task.dataset_id}'

		if event_type == ProcessingNotificationType.completed and not is_dataset_user_visible_ready(status, file_name):
			return ProcessingNotificationBatch(events=[], file_name=file_name)

		payloads = _event_payloads(
			client,
			task,
			event_type,
			dataset_response.data['user_id'],
			status,
		)
		inserted = (
			client.table(settings.processing_notification_events_table)
			.upsert(
				payloads,
				on_conflict='queue_task_id,event_type,recipient_user_id',
				ignore_duplicates=True,
			)
			.execute()
		)

		return ProcessingNotificationBatch(events=inserted.data or [], file_name=file_name)


def dispatch_processing_result(batch: ProcessingNotificationBatch) -> list[dict[str, Any]]:
	"""Dispatch a previously persisted batch; pending rows remain retryable on failure."""
	if not batch.events:
		return []
	with use_service_client() as client:
		return [
			_dispatch_event(client, event, batch.file_name) if event['status'] == 'pending' else event
			for event in batch.events
		]


def notify_processing_result(
	task: QueueTask,
	event_type: ProcessingNotificationType,
) -> list[dict[str, Any]]:
	"""Persist and dispatch processing result notifications."""
	return dispatch_processing_result(record_processing_result(task, event_type))
