"""Failure state is written once, by the orchestrator, and a failure this process
saw is never reported as a container crash."""

from types import SimpleNamespace

import pytest

import processor.src.processor as processor_module
from processor.src.exceptions import ProcessingError
from processor.src.utils.drain_control import BackgroundProcessResult
from shared import status as status_module
from shared.models import QueueTask, StatusEnum, TaskTypeEnum
from shared.redaction import storable_text


def _task(task_types=(TaskTypeEnum.metadata, TaskTypeEnum.cog)) -> QueueTask:
	return QueueTask(
		id=501,
		dataset_id=901,
		user_id='requester',
		task_types=list(task_types),
		priority=1,
		is_processing=True,
		claimed_by='worker-a',
		current_position=1,
	)


class _StatusClient:
	def __init__(self, row):
		self.row = row

	def table(self, name):
		return self

	def select(self, fields):
		return self

	def eq(self, field, value):
		return self

	def execute(self):
		return SimpleNamespace(data=[self.row] if self.row is not None else [])

	def __enter__(self):
		return self

	def __exit__(self, exc_type, exc, tb):
		return False


@pytest.fixture
def quiet_logger(monkeypatch):
	for level in ('info', 'warning', 'error'):
		monkeypatch.setattr(processor_module.logger, level, lambda *args, **kwargs: None)


@pytest.fixture(autouse=True)
def clear_failure_memory():
	processor_module._unrecorded_failures.clear()
	yield
	processor_module._unrecorded_failures.clear()


def _run_stale_recovery(monkeypatch, task, status_row):
	"""Run one poll that finds `task` as this worker's stale active row."""
	failures = []
	completed = []
	active = iter([task])
	monkeypatch.setattr(processor_module.signal, 'signal', lambda *args: None)
	monkeypatch.setattr(processor_module, 'login_verified', lambda *args: ('token', object()))
	monkeypatch.setattr(processor_module, 'get_worker_id', lambda: 'worker-a')
	monkeypatch.setattr(processor_module, 'clear_loop_unhealthy', lambda: None)
	monkeypatch.setattr(processor_module, 'get_active_task', lambda *args: next(active, None))
	monkeypatch.setattr(processor_module, 'use_client', lambda token: _StatusClient(status_row))
	monkeypatch.setattr(processor_module, '_kill_dangling_dataset_resources', lambda dataset_id: None)
	monkeypatch.setattr(processor_module, 'is_drain_requested', lambda: False)
	monkeypatch.setattr(processor_module, 'get_next_task', lambda token: None)
	monkeypatch.setattr(processor_module, '_reconcile_processing_notifications_safely', lambda: None)
	monkeypatch.setattr(
		processor_module, 'update_status', lambda token, **fields: (failures if fields.get('has_error') else completed).append(fields)
	)
	monkeypatch.setattr(processor_module, 'create_processing_failure_issue', lambda **kwargs: None)
	monkeypatch.setattr(processor_module, '_notify_processing_result_safely', lambda *args: None)
	monkeypatch.setattr(processor_module, 'delete_queue_task', lambda token, current: None)
	assert processor_module.background_process() is BackgroundProcessResult.IDLE
	return failures, completed


@pytest.mark.unit
def test_unrecorded_failure_is_reported_with_its_real_error_not_as_a_crash(monkeypatch, quiet_logger):
	"""A database blip during bookkeeping used to surface as 'container crashed'."""
	task = _task([TaskTypeEnum.metadata])
	monkeypatch.setattr(processor_module, 'refresh_processor_token', lambda task, token=None: 'stage-token')
	monkeypatch.setattr(
		processor_module, 'process_metadata', lambda *args: (_ for _ in ()).throw(RuntimeError('admin boundaries timed out'))
	)
	monkeypatch.setattr(
		processor_module, 'login', lambda *args: (_ for _ in ()).throw(RuntimeError('Login failed: connection reset'))
	)

	with pytest.raises(ProcessingError):
		processor_module.process_task(task, 'initial-token')

	assert processor_module._unrecorded_failures[task.id] == (
		'metadata',
		'metadata processing failed: admin boundaries timed out',
	)

	failures, _ = _run_stale_recovery(
		monkeypatch, task, {'current_status': StatusEnum.metadata_processing.value, 'has_error': False}
	)

	assert len(failures) == 1
	assert failures[0]['error_message'] == 'metadata processing failed: admin boundaries timed out'
	assert failures[0]['error_stage'] == 'metadata'
	assert 'crashed' not in failures[0]['error_message']
	assert task.id not in processor_module._unrecorded_failures


@pytest.mark.unit
def test_recorded_failure_whose_dequeue_failed_is_finished_without_a_second_issue(monkeypatch, quiet_logger):
	task = _task()
	processor_module._unrecorded_failures[task.id] = ('cog', 'cog processing failed: boom')
	issues = []
	monkeypatch.setattr(processor_module, 'create_processing_failure_issue', lambda **kwargs: issues.append(kwargs))

	failures, _ = _run_stale_recovery(monkeypatch, task, {'current_status': 'idle', 'has_error': True})

	assert failures == []
	assert issues == []
	assert task.id not in processor_module._unrecorded_failures


@pytest.mark.unit
def test_crashed_rerun_of_a_healthy_dataset_is_failed_not_completed(monkeypatch, quiet_logger):
	"""Done flags from the previous run must not turn a mid-stage kill into success."""
	task = _task()
	stale_rerun_status = {
		'current_status': StatusEnum.cog_processing.value,
		'has_error': False,
		'is_metadata_done': True,
		'is_cog_done': True,
	}

	failures, completed = _run_stale_recovery(monkeypatch, task, stale_rerun_status)

	assert completed == []
	assert len(failures) == 1
	assert 'crashed' in failures[0]['error_message']


@pytest.mark.unit
def test_finished_task_that_died_before_dequeue_is_still_completed(monkeypatch, quiet_logger):
	task = _task()
	finished_status = {'current_status': 'idle', 'has_error': False, 'is_metadata_done': True, 'is_cog_done': True}

	failures, completed = _run_stale_recovery(monkeypatch, task, finished_status)

	assert failures == []
	assert completed == [{'dataset_id': task.dataset_id, 'current_status': StatusEnum.idle, 'has_error': False}]


@pytest.mark.unit
@pytest.mark.parametrize('bad', ['\x00', '\ud83d'])
def test_error_messages_with_unstorable_characters_are_written(monkeypatch, bad):
	written = []

	class _Client:
		def table(self, name):
			return self

		def select(self, fields):
			return self

		def eq(self, field, value):
			return self

		def update(self, data):
			written.append(data)
			return self

		def execute(self):
			return SimpleNamespace(data=[{'id': 1}])

		def __enter__(self):
			return self

		def __exit__(self, exc_type, exc, tb):
			return False

	monkeypatch.setattr(status_module, 'use_client', lambda token: _Client())

	status_module.update_status('token', dataset_id=1, has_error=True, error_message=f'gdal said {bad} here')

	assert written[0]['error_message'] == 'gdal said � here'
	written[0]['error_message'].encode('utf-8')


@pytest.mark.unit
def test_storable_text_keeps_both_ends_of_long_tool_output():
	text = 'START ' + 'x' * 50_000 + ' the real cause'

	stored = storable_text(text, 1_000)

	assert len(stored) == 1_000
	assert stored.startswith('START ')
	assert stored.endswith(' the real cause')
	assert 'truncated' in stored


@pytest.mark.unit
def test_log_context_with_unstorable_characters_is_made_storable():
	from shared.logging import redact_extra

	cleaned = redact_extra({'error': 'bad \udcff name \x00 end'})

	assert cleaned == {'error': 'bad � name � end'}
