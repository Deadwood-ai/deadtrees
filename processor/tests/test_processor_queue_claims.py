import pytest

import processor.src.processor as processor_module
from processor.src.processor import background_process, claim_task, get_active_task, get_worker_id
from shared.models import QueueTask, TaskTypeEnum
from shared.settings import settings

pytestmark = pytest.mark.unit


def test_get_worker_id_requires_explicit_id_outside_dev(monkeypatch):
	monkeypatch.setattr(processor_module.settings, 'PROCESSOR_WORKER_ID', '')
	monkeypatch.setattr(processor_module.settings, 'DEV_MODE', False)
	monkeypatch.setattr(processor_module.Path, 'read_text', lambda self: (_ for _ in ()).throw(FileNotFoundError()))

	with pytest.raises(RuntimeError, match='PROCESSOR_WORKER_ID must be set'):
		get_worker_id()


def test_get_worker_id_allows_local_dev_fallback(monkeypatch):
	monkeypatch.setattr(processor_module.settings, 'PROCESSOR_WORKER_ID', '')
	monkeypatch.setattr(processor_module.settings, 'DEV_MODE', True)
	monkeypatch.setattr(processor_module.socket, 'gethostname', lambda: 'dev-host')

	assert get_worker_id() == 'local-dev-dev-host'


def test_get_worker_id_uses_host_machine_id_outside_dev(monkeypatch):
	monkeypatch.setattr(processor_module.settings, 'PROCESSOR_WORKER_ID', '')
	monkeypatch.setattr(processor_module.settings, 'DEV_MODE', False)
	monkeypatch.setattr(processor_module.Path, 'read_text', lambda self: '0123456789abcdef\n')

	assert get_worker_id() == 'host-0123456789ab'


def test_claim_task_atomically_marks_waiting_row(monkeypatch):
	"""A worker claim only succeeds while the queue row is still waiting."""
	task = QueueTask(
		id=123,
		dataset_id=456,
		user_id='test-user',
		task_types=[TaskTypeEnum.metadata],
		priority=1,
		is_processing=False,
		current_position=3,
		estimated_time=12.0,
	)
	updates = []
	filters = []

	class _UpdateQuery:
		def __init__(self, payload):
			self.payload = payload

		def eq(self, field, value):
			filters.append((field, value))
			return self

		def is_(self, field, value):
			filters.append((field, 'is', value))
			return self

		def execute(self):
			updates.append(self.payload)
			return type('Response', (), {'data': [{
				'id': task.id,
				'dataset_id': task.dataset_id,
				'user_id': task.user_id,
				'priority': task.priority,
				'is_processing': True,
				'claimed_by': self.payload['claimed_by'],
				'claimed_at': self.payload['claimed_at'],
				'task_types': task.task_types,
			}]})()

	class _TableQuery:
		def update(self, payload):
			return _UpdateQuery(payload)

	class _FakeClient:
		def table(self, name):
			assert name == settings.queue_table
			return _TableQuery()

		def __enter__(self):
			return self

		def __exit__(self, exc_type, exc, tb):
			return False

	monkeypatch.setattr(processor_module, 'use_client', lambda token: _FakeClient())

	claimed = claim_task('token', task, 'worker-a')

	assert claimed is not None
	assert claimed.id == task.id
	assert claimed.current_position == task.current_position
	assert claimed.estimated_time == task.estimated_time
	assert claimed.is_processing is True
	assert claimed.claimed_by == 'worker-a'
	assert filters == [('id', task.id), ('is_processing', False), ('claimed_by', 'is', 'null')]
	assert updates[0]['is_processing'] is True
	assert updates[0]['claimed_by'] == 'worker-a'
	assert updates[0]['claimed_at']


def test_claim_task_returns_none_when_row_is_already_claimed(monkeypatch):
	task = QueueTask(
		id=123,
		dataset_id=456,
		user_id='test-user',
		task_types=[TaskTypeEnum.metadata],
		priority=1,
		is_processing=False,
		current_position=3,
		estimated_time=12.0,
	)

	class _UpdateQuery:
		def eq(self, field, value):
			return self

		def is_(self, field, value):
			return self

		def execute(self):
			return type('Response', (), {'data': []})()

	class _TableQuery:
		def update(self, payload):
			return _UpdateQuery()

	class _FakeClient:
		def table(self, name):
			assert name == settings.queue_table
			return _TableQuery()

		def __enter__(self):
			return self

		def __exit__(self, exc_type, exc, tb):
			return False

	monkeypatch.setattr(processor_module, 'use_client', lambda token: _FakeClient())

	assert claim_task('token', task, 'worker-a') is None


def test_claim_task_falls_back_while_claim_columns_are_missing(monkeypatch):
	task = QueueTask(
		id=123,
		dataset_id=456,
		user_id='test-user',
		task_types=[TaskTypeEnum.metadata],
		priority=1,
		is_processing=False,
		current_position=3,
		estimated_time=12.0,
	)
	payloads = []

	class _UpdateQuery:
		def __init__(self, payload):
			self.payload = payload
			self.used_claim_filter = False

		def eq(self, field, value):
			return self

		def is_(self, field, value):
			self.used_claim_filter = True
			return self

		def execute(self):
			if self.used_claim_filter:
				raise Exception("Could not find the 'claimed_by' column in the schema cache")
			payloads.append(self.payload)
			return type('Response', (), {'data': [{
				'id': task.id,
				'dataset_id': task.dataset_id,
				'user_id': task.user_id,
				'priority': task.priority,
				'is_processing': True,
				'task_types': task.task_types,
			}]})()

	class _TableQuery:
		def update(self, payload):
			return _UpdateQuery(payload)

	class _FakeClient:
		def table(self, name):
			assert name == settings.queue_table
			return _TableQuery()

		def __enter__(self):
			return self

		def __exit__(self, exc_type, exc, tb):
			return False

	monkeypatch.setattr(processor_module, 'use_client', lambda token: _FakeClient())
	monkeypatch.setattr(processor_module.logger, 'warning', lambda *args, **kwargs: None)

	claimed = claim_task('token', task, 'worker-a')

	assert claimed is not None
	assert claimed.id == task.id
	assert claimed.is_processing is True
	assert claimed.claimed_by is None
	assert payloads == [{'is_processing': True}]


def test_get_active_task_atomically_adopts_legacy_active_row(monkeypatch):
	legacy_row = {
		'id': 123,
		'dataset_id': 456,
		'user_id': 'test-user',
		'priority': 1,
		'is_processing': True,
		'claimed_by': None,
		'claimed_at': None,
		'task_types': [TaskTypeEnum.metadata],
	}
	updates = []

	class _Query:
		def __init__(self):
			self.payload = None
			self.filters = []

		def select(self, columns):
			return self

		def update(self, payload):
			self.payload = payload
			return self

		def eq(self, field, value):
			self.filters.append((field, value))
			return self

		def is_(self, field, value):
			self.filters.append((field, 'is', value))
			return self

		def order(self, *args, **kwargs):
			return self

		def limit(self, count):
			return self

		def execute(self):
			if self.payload is not None:
				updates.append((self.payload, self.filters))
				return type('Response', (), {'data': [{**legacy_row, **self.payload}]})()
			if ('claimed_by', 'worker-a') in self.filters:
				return type('Response', (), {'data': []})()
			return type('Response', (), {'data': [legacy_row]})()

	class _FakeClient:
		def table(self, name):
			assert name == settings.queue_table
			return _Query()

		def __enter__(self):
			return self

		def __exit__(self, exc_type, exc, tb):
			return False

	monkeypatch.setattr(processor_module, 'use_client', lambda token: _FakeClient())

	task = get_active_task('token', 'worker-a')

	assert task is not None
	assert task.id == legacy_row['id']
	assert task.claimed_by == 'worker-a'
	assert updates[0][0]['claimed_by'] == 'worker-a'
	assert ('id', legacy_row['id']) in updates[0][1]
	assert ('is_processing', True) in updates[0][1]
	assert ('claimed_by', 'is', 'null') in updates[0][1]


def test_get_active_task_falls_back_while_claim_columns_are_missing(monkeypatch):
	legacy_row = {
		'id': 123,
		'dataset_id': 456,
		'user_id': 'test-user',
		'priority': 1,
		'is_processing': True,
		'task_types': [TaskTypeEnum.metadata],
	}

	class _Query:
		def __init__(self):
			self.filters = []

		def select(self, columns):
			return self

		def eq(self, field, value):
			if field == 'claimed_by':
				raise Exception("Could not find the 'claimed_by' column in the schema cache")
			self.filters.append((field, value))
			return self

		def order(self, *args, **kwargs):
			return self

		def limit(self, count):
			return self

		def execute(self):
			return type('Response', (), {'data': [legacy_row]})()

	class _FakeClient:
		def table(self, name):
			assert name == settings.queue_table
			return _Query()

		def __enter__(self):
			return self

		def __exit__(self, exc_type, exc, tb):
			return False

	monkeypatch.setattr(processor_module, 'use_client', lambda token: _FakeClient())
	monkeypatch.setattr(processor_module.logger, 'warning', lambda *args, **kwargs: None)

	task = get_active_task('token', 'worker-a')

	assert task is not None
	assert task.id == legacy_row['id']
	assert task.claimed_by is None


def test_get_active_task_returns_none_when_legacy_adoption_race_is_lost(monkeypatch):
	legacy_row = {
		'id': 123,
		'dataset_id': 456,
		'user_id': 'test-user',
		'priority': 1,
		'is_processing': True,
		'claimed_by': None,
		'claimed_at': None,
		'task_types': [TaskTypeEnum.metadata],
	}

	class _Query:
		def __init__(self):
			self.payload = None
			self.filters = []

		def select(self, columns):
			return self

		def update(self, payload):
			self.payload = payload
			return self

		def eq(self, field, value):
			self.filters.append((field, value))
			return self

		def is_(self, field, value):
			self.filters.append((field, 'is', value))
			return self

		def order(self, *args, **kwargs):
			return self

		def limit(self, count):
			return self

		def execute(self):
			if self.payload is not None:
				return type('Response', (), {'data': []})()
			if ('claimed_by', 'worker-a') in self.filters:
				return type('Response', (), {'data': []})()
			return type('Response', (), {'data': [legacy_row]})()

	class _FakeClient:
		def table(self, name):
			assert name == settings.queue_table
			return _Query()

		def __enter__(self):
			return self

		def __exit__(self, exc_type, exc, tb):
			return False

	monkeypatch.setattr(processor_module, 'use_client', lambda token: _FakeClient())

	assert get_active_task('token', 'worker-a') is None


def test_background_process_claims_ready_task_before_processing(monkeypatch):
	task = QueueTask(
		id=123,
		dataset_id=456,
		user_id='test-user',
		task_types=[TaskTypeEnum.metadata],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
	)
	claimed_task = task.model_copy(update={'is_processing': True, 'claimed_by': 'worker-a'})
	processed_tasks = []

	monkeypatch.setattr(processor_module, 'login_verified', lambda username, password: ('token', {'id': 'processor'}))
	monkeypatch.setattr(processor_module, 'get_worker_id', lambda: 'worker-a')
	monkeypatch.setattr(processor_module, 'get_active_task', lambda token, worker_id: None)
	monkeypatch.setattr(processor_module, 'get_next_task', lambda token: task)
	monkeypatch.setattr(processor_module, 'is_dataset_uploaded_or_processed', lambda current_task, token: (True, False))
	monkeypatch.setattr(processor_module, 'claim_task', lambda token, current_task, worker_id: claimed_task)
	monkeypatch.setattr(processor_module, 'process_task', lambda current_task, token: processed_tasks.append(current_task))

	class _StatusQuery:
		def select(self, columns):
			return self

		def eq(self, field, value):
			return self

		def execute(self):
			return type('Response', (), {'data': [{'current_status': 'idle'}]})()

	class _FakeClient:
		def table(self, name):
			assert name == settings.statuses_table
			return _StatusQuery()

		def __enter__(self):
			return self

		def __exit__(self, exc_type, exc, tb):
			return False

	monkeypatch.setattr(processor_module, 'use_client', lambda token: _FakeClient())

	background_process()

	assert processed_tasks == [claimed_task]


def test_background_process_skips_ready_task_when_claim_is_lost(monkeypatch):
	task = QueueTask(
		id=123,
		dataset_id=456,
		user_id='test-user',
		task_types=[TaskTypeEnum.metadata],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
	)
	claim_calls = []
	processed_tasks = []

	monkeypatch.setattr(processor_module, 'login_verified', lambda username, password: ('token', {'id': 'processor'}))
	monkeypatch.setattr(processor_module, 'get_worker_id', lambda: 'worker-a')
	monkeypatch.setattr(processor_module, 'get_active_task', lambda token, worker_id: None)
	monkeypatch.setattr(
		processor_module,
		'get_next_task',
		lambda token: task if len(claim_calls) == 0 else None,
	)
	monkeypatch.setattr(processor_module, 'is_dataset_uploaded_or_processed', lambda current_task, token: (True, False))

	def _claim_task(token, current_task, worker_id):
		claim_calls.append((current_task.id, worker_id))
		return None

	monkeypatch.setattr(processor_module, 'claim_task', _claim_task)
	monkeypatch.setattr(processor_module, 'process_task', lambda current_task, token: processed_tasks.append(current_task))

	background_process()

	assert claim_calls == [(task.id, 'worker-a')]
	assert processed_tasks == []
