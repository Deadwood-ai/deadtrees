from datetime import datetime, timedelta, timezone

import pytest

from shared.db import login, use_client, use_service_client
from shared.models import QueueTask, TaskTypeEnum
from shared.notifications import processing as processing_notifications
from shared.notifications.processing import ProcessingNotificationType
from shared.settings import settings


def make_notification_retry_due(event_id: str) -> None:
	with use_service_client() as client:
		client.table('processing_notification_events').update(
			{'next_attempt_at': (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()}
		).eq('id', event_id).execute()


@pytest.fixture
def notification_preference_rows(test_user, test_user2):
	with use_service_client() as client:
		client.table('user_notification_preferences').delete().in_('user_id', [test_user, test_user2]).execute()
		client.table('user_notification_preferences').insert(
			[
				{'user_id': test_user, 'processing_emails_enabled': True},
				{'user_id': test_user2, 'processing_emails_enabled': False},
			]
		).execute()

	yield

	with use_service_client() as client:
		client.table('user_notification_preferences').delete().in_('user_id', [test_user, test_user2]).execute()


@pytest.fixture
def privileged_notification_requester(test_user2):
	with use_service_client() as client:
		client.table('privileged_users').delete().eq('user_id', test_user2).execute()
		client.table('privileged_users').insert(
			{
				'user_id': test_user2,
				'can_upload_private': False,
				'can_view_all_private': True,
				'can_audit': False,
			}
		).execute()

	yield

	with use_service_client() as client:
		client.table('privileged_users').delete().eq('user_id', test_user2).execute()


def test_users_can_only_read_and_update_their_own_notification_preferences(
	notification_preference_rows, auth_token, test_user, test_user2
):
	with use_client(auth_token) as client:
		rows = client.table('user_notification_preferences').select('*').execute().data
		assert len(rows) == 1
		assert rows[0]['user_id'] == test_user
		assert rows[0]['processing_emails_enabled'] is True

		updated = (
			client.table('user_notification_preferences')
			.update({'processing_emails_enabled': False})
			.eq('user_id', test_user)
			.execute()
			.data
		)
		assert len(updated) == 1
		assert updated[0]['processing_emails_enabled'] is False

		other_update = (
			client.table('user_notification_preferences')
			.update({'processing_emails_enabled': True})
			.eq('user_id', test_user2)
			.execute()
			.data
		)
		assert other_update == []


def test_user_can_create_default_on_preference_row(test_user2):
	token = login(
		settings.TEST_USER_EMAIL2,
		settings.TEST_USER_PASSWORD2,
		use_cached_session=False,
	)

	with use_service_client() as service_client:
		service_client.table('user_notification_preferences').delete().eq('user_id', test_user2).execute()

	try:
		with use_client(token) as client:
			created = (
				client.table('user_notification_preferences')
				.insert({'user_id': test_user2})
				.execute()
				.data
			)
			assert len(created) == 1
			assert created[0]['processing_emails_enabled'] is True
	finally:
		with use_service_client() as service_client:
			service_client.table('user_notification_preferences').delete().eq('user_id', test_user2).execute()


@pytest.fixture
def test_dataset_for_notification(auth_token, test_user):
	dataset_id = None
	try:
		with use_client(auth_token) as client:
			created = client.table(settings.datasets_table).insert(
				{
					'file_name': 'notification-test.tif',
					'user_id': test_user,
					'license': 'CC BY',
					'platform': 'drone',
					'authors': ['Notification Test'],
					'data_access': 'private',
					'aquisition_year': 2026,
					'aquisition_month': 7,
					'aquisition_day': 16,
				}
			).execute()
			dataset_id = created.data[0]['id']
		yield dataset_id
	finally:
		if dataset_id is not None:
			with use_service_client() as client:
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_processing_notification_outbox_is_service_role_only(
	auth_token, test_user, test_dataset_for_notification
):
	event = {
		'queue_task_id': 987654,
		'dataset_id': test_dataset_for_notification,
		'event_type': 'processing_completed',
		'recipient_user_id': test_user,
		'recipient_email': settings.TEST_USER_EMAIL,
		'recipient_roles': ['owner'],
		'task_types': ['metadata'],
	}

	with use_client(auth_token) as client:
		with pytest.raises(Exception):
			client.table('processing_notification_events').insert(event).execute()
		with pytest.raises(Exception):
			client.table('processing_notification_events').select('*').execute()

	with use_service_client() as service_client:
		created = service_client.table('processing_notification_events').insert(event).execute().data
		assert len(created) == 1
		assert created[0]['status'] == 'pending'

		with pytest.raises(Exception):
			service_client.table('processing_notification_events').insert(event).execute()

		service_client.table('processing_notification_events').delete().eq('id', created[0]['id']).execute()


def test_queue_requester_must_match_authenticated_user(auth_token, test_user2, test_dataset_for_notification):
	with use_client(auth_token) as client:
		with pytest.raises(Exception):
			client.table(settings.queue_table).insert(
				{
					'dataset_id': test_dataset_for_notification,
					'user_id': test_user2,
					'task_types': ['metadata'],
				}
			).execute()


def test_queue_requester_must_be_authorized_for_dataset(test_user2, test_dataset_for_notification):
	token = login(
		settings.TEST_USER_EMAIL2,
		settings.TEST_USER_PASSWORD2,
		use_cached_session=False,
	)

	with use_client(token) as client:
		with pytest.raises(Exception):
			client.table(settings.queue_table).insert(
				{
					'dataset_id': test_dataset_for_notification,
					'user_id': test_user2,
					'task_types': ['metadata'],
				}
			).execute()


def test_dataset_owner_can_enqueue_with_trusted_requester(auth_token, test_user, test_dataset_for_notification):
	queue_id = None
	try:
		with use_client(auth_token) as client:
			created = client.table(settings.queue_table).insert(
				{
					'dataset_id': test_dataset_for_notification,
					'user_id': test_user,
					'task_types': ['metadata'],
				}
			).execute().data
			queue_id = created[0]['id']
			assert created[0]['user_id'] == test_user
	finally:
		if queue_id is not None:
			with use_service_client() as client:
				client.table(settings.queue_table).delete().eq('id', queue_id).execute()


def test_privileged_user_can_enqueue_on_behalf_of_owner(test_user2, test_dataset_for_notification):
	token = login(
		settings.TEST_USER_EMAIL2,
		settings.TEST_USER_PASSWORD2,
		use_cached_session=False,
	)
	queue_id = None
	with use_service_client() as client:
		client.table('privileged_users').delete().eq('user_id', test_user2).execute()
		client.table('privileged_users').insert(
			{
				'user_id': test_user2,
				'can_upload_private': False,
				'can_view_all_private': True,
				'can_audit': False,
			}
		).execute()

	try:
		with use_client(token) as client:
			created = client.table(settings.queue_table).insert(
				{
					'dataset_id': test_dataset_for_notification,
					'user_id': test_user2,
					'task_types': ['metadata'],
				}
			).execute().data
			queue_id = created[0]['id']
			assert created[0]['user_id'] == test_user2
	finally:
		with use_service_client() as client:
			if queue_id is not None:
				client.table(settings.queue_table).delete().eq('id', queue_id).execute()
			client.table('privileged_users').delete().eq('user_id', test_user2).execute()


def test_failed_notification_tolerates_missing_status_row(
	test_dataset_for_notification, test_user, monkeypatch
):
	sent = []
	with use_service_client() as client:
		client.table(settings.statuses_table).delete().eq(
			'dataset_id',
			test_dataset_for_notification,
		).execute()

	monkeypatch.setattr(settings, 'PROCESSING_EMAIL_NOTIFICATIONS_ENABLED', True)
	monkeypatch.setattr(
		processing_notifications,
		'send_email',
		lambda to_email, subject, html_body, **kwargs: sent.append(to_email)
		or {'success': True, 'method': 'test', 'message_id': 'message-without-status'},
	)
	task = QueueTask(
		id=555000,
		dataset_id=test_dataset_for_notification,
		user_id=test_user,
		priority=2,
		is_processing=True,
		current_position=1,
		task_types=[TaskTypeEnum.metadata],
	)

	result = processing_notifications.notify_processing_result(
		task,
		ProcessingNotificationType.failed,
	)

	assert sent == [settings.TEST_USER_EMAIL]
	assert len(result) == 1
	assert result[0]['status'] == 'sent'
	assert result[0]['status_snapshot'] == {}

	with use_service_client() as client:
		client.table('processing_notification_events').delete().eq('queue_task_id', task.id).execute()


@pytest.fixture
def completed_notification_dataset(test_user):
	dataset_id = None
	try:
		with use_service_client() as client:
			dataset = client.table(settings.datasets_table).insert(
				{
					'file_name': 'completed-notification.tif',
					'user_id': test_user,
					'license': 'CC BY',
					'platform': 'drone',
					'authors': ['Notification Test'],
					'data_access': 'private',
					'aquisition_year': 2026,
					'aquisition_month': 7,
					'aquisition_day': 16,
				}
			).execute().data[0]
			dataset_id = dataset['id']
			client.table(settings.statuses_table).insert(
				{
					'dataset_id': dataset_id,
					'current_status': 'idle',
					'is_upload_done': True,
					'is_ortho_done': True,
					'is_metadata_done': True,
					'is_cog_done': True,
					'is_thumbnail_done': True,
					'is_deadwood_done': True,
					'is_forest_cover_done': True,
					'has_error': False,
				}
			).execute()
		yield dataset_id
	finally:
		if dataset_id is not None:
			with use_service_client() as client:
				client.table('processing_notification_events').delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_processing_result_sends_owner_and_requester_once(
	completed_notification_dataset, test_user, test_user2, privileged_notification_requester, monkeypatch
):
	sent = []
	monkeypatch.setattr(settings, 'PROCESSING_EMAIL_NOTIFICATIONS_ENABLED', True)
	monkeypatch.setattr(
		processing_notifications,
		'send_email',
		lambda to_email, subject, html_body, **kwargs: sent.append(to_email)
		or {'success': True, 'method': 'test', 'message_id': f'message-{len(sent)}'},
	)
	task = QueueTask(
		id=555001,
		dataset_id=completed_notification_dataset,
		user_id=test_user2,
		priority=2,
		is_processing=True,
		current_position=1,
		task_types=[TaskTypeEnum.metadata],
	)

	first_result = processing_notifications.notify_processing_result(
		task,
		ProcessingNotificationType.completed,
	)
	second_result = processing_notifications.notify_processing_result(
		task,
		ProcessingNotificationType.completed,
	)

	assert len(first_result) == 2
	assert second_result == []
	assert sorted(sent) == sorted([settings.TEST_USER_EMAIL, settings.TEST_USER_EMAIL2])

	with use_service_client() as client:
		events = (
			client.table('processing_notification_events')
			.select('recipient_user_id,recipient_roles,status')
			.eq('queue_task_id', task.id)
			.execute()
			.data
		)
	assert len(events) == 2
	assert {event['recipient_user_id'] for event in events} == {test_user, test_user2}
	assert {event['status'] for event in events} == {'sent'}


def test_legacy_unauthorized_requester_is_not_notified(
	completed_notification_dataset, test_user, test_user2, monkeypatch
):
	sent = []
	with use_service_client() as client:
		client.table('privileged_users').delete().eq('user_id', test_user2).execute()
	monkeypatch.setattr(settings, 'PROCESSING_EMAIL_NOTIFICATIONS_ENABLED', True)
	monkeypatch.setattr(
		processing_notifications,
		'send_email',
		lambda to_email, subject, html_body, **kwargs: sent.append(to_email)
		or {'success': True, 'method': 'test', 'message_id': 'owner-only'},
	)
	task = QueueTask(
		id=555010,
		dataset_id=completed_notification_dataset,
		user_id=test_user2,
		priority=2,
		is_processing=True,
		current_position=1,
		task_types=[TaskTypeEnum.metadata],
	)

	result = processing_notifications.notify_processing_result(task, ProcessingNotificationType.completed)

	assert sent == [settings.TEST_USER_EMAIL]
	assert len(result) == 1
	assert result[0]['recipient_user_id'] == test_user
	assert result[0]['recipient_roles'] == ['owner']


def test_processing_result_respects_default_on_opt_out(
	completed_notification_dataset, test_user, test_user2, privileged_notification_requester, monkeypatch
):
	sent = []
	monkeypatch.setattr(settings, 'PROCESSING_EMAIL_NOTIFICATIONS_ENABLED', True)
	monkeypatch.setattr(
		processing_notifications,
		'send_email',
		lambda to_email, subject, html_body, **kwargs: sent.append(to_email)
		or {'success': True, 'method': 'test', 'message_id': 'message-owner'},
	)
	with use_service_client() as client:
		client.table('user_notification_preferences').upsert(
			{'user_id': test_user2, 'processing_emails_enabled': False},
			on_conflict='user_id',
		).execute()

	try:
		task = QueueTask(
			id=555002,
			dataset_id=completed_notification_dataset,
			user_id=test_user2,
			priority=2,
			is_processing=True,
			current_position=1,
			task_types=[TaskTypeEnum.metadata],
		)
		processing_notifications.notify_processing_result(task, ProcessingNotificationType.completed)

		assert sent == [settings.TEST_USER_EMAIL]
		with use_service_client() as client:
			events = (
				client.table('processing_notification_events')
				.select('id,recipient_user_id,status,delivery_error')
				.eq('queue_task_id', task.id)
				.execute()
				.data
			)
		assert {event['status'] for event in events} == {'sent', 'skipped'}
		skipped = next(event for event in events if event['status'] == 'skipped')
		assert skipped['recipient_user_id'] == test_user2
		assert skipped['delivery_error'] == 'user_opted_out'
	finally:
		with use_service_client() as client:
			client.table('user_notification_preferences').delete().eq('user_id', test_user2).execute()


def test_recipient_lookup_failure_does_not_block_other_recipient(
	completed_notification_dataset, test_user, test_user2, privileged_notification_requester, monkeypatch
):
	sent = []

	def get_user_email(client, user_id):
		if user_id == test_user:
			raise RuntimeError('auth unavailable')
		return settings.TEST_USER_EMAIL2

	monkeypatch.setattr(settings, 'PROCESSING_EMAIL_NOTIFICATIONS_ENABLED', True)
	monkeypatch.setattr(
		processing_notifications,
		'_get_user_email',
		get_user_email,
	)
	monkeypatch.setattr(
		processing_notifications,
		'send_email',
		lambda to_email, subject, html_body, **kwargs: sent.append(to_email)
		or {'success': True, 'method': 'test', 'message_id': 'message-requester'},
	)
	task = QueueTask(
		id=555004,
		dataset_id=completed_notification_dataset,
		user_id=test_user2,
		priority=2,
		is_processing=True,
		current_position=1,
		task_types=[TaskTypeEnum.metadata],
	)

	processing_notifications.notify_processing_result(task, ProcessingNotificationType.completed)

	assert sent == [settings.TEST_USER_EMAIL2]
	with use_service_client() as client:
			events = (
				client.table('processing_notification_events')
				.select('id,recipient_user_id,status,delivery_error')
				.eq('queue_task_id', task.id)
			.execute()
			.data
		)
	assert len(events) == 2
	owner_event = next(event for event in events if event['recipient_user_id'] == test_user)
	assert owner_event['status'] == 'failed'
	assert owner_event['delivery_error'] == 'recipient_email_lookup_failed'
	assert processing_notifications.reconcile_processing_notifications() == []

	monkeypatch.setattr(
		processing_notifications,
		'_get_user_email',
		lambda client, user_id: settings.TEST_USER_EMAIL if user_id == test_user else settings.TEST_USER_EMAIL2,
	)
	make_notification_retry_due(owner_event['id'])
	retry_result = processing_notifications.reconcile_processing_notifications()

	assert retry_result[0]['status'] == 'sent'
	assert retry_result[0]['delivery_attempts'] == 1
	assert sent == [settings.TEST_USER_EMAIL2, settings.TEST_USER_EMAIL]


def test_disabled_delivery_does_not_access_service_role_or_record_events(
	completed_notification_dataset, test_user, monkeypatch
):
	sent = []
	monkeypatch.setattr(settings, 'PROCESSING_EMAIL_NOTIFICATIONS_ENABLED', False)
	monkeypatch.setattr(settings, 'SUPABASE_SERVICE_ROLE_KEY', '')
	monkeypatch.setattr(
		processing_notifications,
		'send_email',
		lambda *args, **kwargs: sent.append(args) or {'success': True, 'method': 'test'},
	)
	task = QueueTask(
		id=555003,
		dataset_id=completed_notification_dataset,
		user_id=test_user,
		priority=2,
		is_processing=True,
		current_position=1,
		task_types=[TaskTypeEnum.metadata],
	)

	result = processing_notifications.notify_processing_result(
		task,
		ProcessingNotificationType.failed,
	)

	assert sent == []
	assert result == []


def test_failed_delivery_is_retried_with_the_same_idempotency_key(
	completed_notification_dataset, test_user, monkeypatch
):
	deliveries = []

	def send_email(to_email, subject, html_body, **kwargs):
		deliveries.append(kwargs['idempotency_key'])
		if len(deliveries) == 1:
			return {'success': False, 'method': 'test', 'error': 'provider_unavailable'}
		return {'success': True, 'method': 'test', 'message_id': 'retry-message'}

	monkeypatch.setattr(settings, 'PROCESSING_EMAIL_NOTIFICATIONS_ENABLED', True)
	monkeypatch.setattr(processing_notifications, 'send_email', send_email)
	task = QueueTask(
		id=555005,
		dataset_id=completed_notification_dataset,
		user_id=test_user,
		priority=2,
		is_processing=True,
		current_position=1,
		task_types=[TaskTypeEnum.metadata],
	)

	first_result = processing_notifications.notify_processing_result(task, ProcessingNotificationType.failed)
	assert processing_notifications.reconcile_processing_notifications() == []
	make_notification_retry_due(first_result[0]['id'])
	retry_result = processing_notifications.reconcile_processing_notifications()

	assert first_result[0]['status'] == 'failed'
	assert first_result[0]['delivery_attempts'] == 1
	assert retry_result[0]['status'] == 'sent'
	assert retry_result[0]['delivery_attempts'] == 2
	assert deliveries == [first_result[0]['id'], first_result[0]['id']]
	assert processing_notifications.reconcile_processing_notifications() == []


def test_retry_skips_requester_after_privilege_revocation(
	completed_notification_dataset,
	test_user,
	test_user2,
	privileged_notification_requester,
	monkeypatch,
):
	deliveries = []

	def send_email(to_email, subject, html_body, **kwargs):
		deliveries.append(to_email)
		if to_email == settings.TEST_USER_EMAIL2:
			return {'success': False, 'method': 'test', 'error': 'provider_unavailable'}
		return {'success': True, 'method': 'test', 'message_id': 'owner-message'}

	monkeypatch.setattr(settings, 'PROCESSING_EMAIL_NOTIFICATIONS_ENABLED', True)
	monkeypatch.setattr(processing_notifications, 'send_email', send_email)
	task = QueueTask(
		id=555011,
		dataset_id=completed_notification_dataset,
		user_id=test_user2,
		priority=2,
		is_processing=True,
		current_position=1,
		task_types=[TaskTypeEnum.metadata],
	)

	first_result = processing_notifications.notify_processing_result(task, ProcessingNotificationType.completed)
	requester_event = next(event for event in first_result if event['recipient_user_id'] == test_user2)
	assert requester_event['status'] == 'failed'

	with use_service_client() as client:
		client.table('privileged_users').delete().eq('user_id', test_user2).execute()
	make_notification_retry_due(requester_event['id'])
	retry_result = processing_notifications.reconcile_processing_notifications()

	assert retry_result[0]['status'] == 'skipped'
	assert retry_result[0]['delivery_error'] == 'recipient_unauthorized'
	assert deliveries.count(settings.TEST_USER_EMAIL2) == 1
	assert deliveries.count(settings.TEST_USER_EMAIL) == 1


def test_pending_delivery_is_reconciled_exactly_once(completed_notification_dataset, test_user, monkeypatch):
	deliveries = []
	monkeypatch.setattr(settings, 'PROCESSING_EMAIL_NOTIFICATIONS_ENABLED', True)
	monkeypatch.setattr(
		processing_notifications,
		'send_email',
		lambda *args, **kwargs: deliveries.append(kwargs['idempotency_key'])
		or {'success': True, 'method': 'test', 'message_id': 'pending-message'},
	)

	with use_service_client() as client:
		event = (
			client.table('processing_notification_events')
			.insert(
				{
					'queue_task_id': 555009,
					'dataset_id': completed_notification_dataset,
					'event_type': ProcessingNotificationType.failed.value,
					'recipient_user_id': test_user,
					'recipient_email': 'processor-test@example.com',
					'recipient_roles': ['owner'],
					'task_types': ['metadata'],
					'status': 'pending',
				}
			)
			.execute()
			.data[0]
		)

	first_result = processing_notifications.reconcile_processing_notifications()
	second_result = processing_notifications.reconcile_processing_notifications()

	assert first_result[0]['status'] == 'sent'
	assert first_result[0]['delivery_attempts'] == 1
	assert deliveries == [event['id']]
	assert second_result == []


def test_stale_sending_delivery_is_reclaimed_after_interruption(
	completed_notification_dataset, test_user, monkeypatch
):
	deliveries = []

	def send_email(to_email, subject, html_body, **kwargs):
		deliveries.append(kwargs['idempotency_key'])
		if len(deliveries) == 1:
			raise RuntimeError('worker interrupted after claim')
		return {'success': True, 'method': 'test', 'message_id': 'recovered-message'}

	monkeypatch.setattr(settings, 'PROCESSING_EMAIL_NOTIFICATIONS_ENABLED', True)
	monkeypatch.setattr(processing_notifications, 'send_email', send_email)
	task = QueueTask(
		id=555006,
		dataset_id=completed_notification_dataset,
		user_id=test_user,
		priority=2,
		is_processing=True,
		current_position=1,
		task_types=[TaskTypeEnum.metadata],
	)

	with pytest.raises(RuntimeError, match='worker interrupted'):
		processing_notifications.notify_processing_result(task, ProcessingNotificationType.failed)

	stale_at = (datetime.now(timezone.utc) - timedelta(minutes=20)).isoformat()
	with use_service_client() as client:
		event = (
			client.table('processing_notification_events')
			.select('*')
			.eq('queue_task_id', task.id)
			.single()
			.execute()
			.data
		)
		assert event['status'] == 'sending'
		client.table('processing_notification_events').update({'updated_at': stale_at}).eq('id', event['id']).execute()

	retry_result = processing_notifications.reconcile_processing_notifications()

	assert retry_result[0]['status'] == 'sent'
	assert retry_result[0]['delivery_attempts'] == 2
	assert deliveries == [event['id'], event['id']]


def test_retry_rechecks_user_opt_out(completed_notification_dataset, test_user, monkeypatch):
	deliveries = []
	monkeypatch.setattr(settings, 'PROCESSING_EMAIL_NOTIFICATIONS_ENABLED', True)
	monkeypatch.setattr(
		processing_notifications,
		'send_email',
		lambda *args, **kwargs: deliveries.append(kwargs['idempotency_key'])
		or {'success': False, 'method': 'test', 'error': 'provider_unavailable'},
	)
	task = QueueTask(
		id=555007,
		dataset_id=completed_notification_dataset,
		user_id=test_user,
		priority=2,
		is_processing=True,
		current_position=1,
		task_types=[TaskTypeEnum.metadata],
	)
	first_result = processing_notifications.notify_processing_result(task, ProcessingNotificationType.failed)
	with use_service_client() as client:
		client.table('user_notification_preferences').upsert(
			{'user_id': test_user, 'processing_emails_enabled': False},
			on_conflict='user_id',
		).execute()

	try:
		make_notification_retry_due(first_result[0]['id'])
		retry_result = processing_notifications.reconcile_processing_notifications()
		assert retry_result[0]['status'] == 'skipped'
		assert retry_result[0]['delivery_error'] == 'user_opted_out'
		assert deliveries == [first_result[0]['id']]
	finally:
		with use_service_client() as client:
			client.table('user_notification_preferences').delete().eq('user_id', test_user).execute()


def test_failed_delivery_stops_after_bounded_attempts(
	completed_notification_dataset, test_user, monkeypatch
):
	deliveries = []
	monkeypatch.setattr(settings, 'PROCESSING_EMAIL_NOTIFICATIONS_ENABLED', True)
	monkeypatch.setattr(
		processing_notifications,
		'send_email',
		lambda *args, **kwargs: deliveries.append(kwargs['idempotency_key'])
		or {'success': False, 'method': 'test', 'error': 'provider_unavailable'},
	)
	task = QueueTask(
		id=555008,
		dataset_id=completed_notification_dataset,
		user_id=test_user,
		priority=2,
		is_processing=True,
		current_position=1,
		task_types=[TaskTypeEnum.metadata],
	)

	first_result = processing_notifications.notify_processing_result(task, ProcessingNotificationType.failed)
	assert processing_notifications.reconcile_processing_notifications() == []
	for _ in range(processing_notifications.MAX_DELIVERY_ATTEMPTS - 1):
		make_notification_retry_due(first_result[0]['id'])
		processing_notifications.reconcile_processing_notifications()
	final_result = processing_notifications.reconcile_processing_notifications()

	assert len(deliveries) == processing_notifications.MAX_DELIVERY_ATTEMPTS
	assert set(deliveries) == {first_result[0]['id']}
	assert final_result == []
	with use_service_client() as client:
		event = (
			client.table('processing_notification_events')
			.select('status,delivery_attempts,delivery_error')
			.eq('id', first_result[0]['id'])
			.single()
			.execute()
			.data
		)
	assert event == {
		'status': 'failed',
		'delivery_attempts': processing_notifications.MAX_DELIVERY_ATTEMPTS,
		'delivery_error': 'provider_unavailable',
	}
