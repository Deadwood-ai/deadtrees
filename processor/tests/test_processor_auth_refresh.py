from types import SimpleNamespace

import pytest

import processor.src.process_geotiff as geotiff_module
import processor.src.processor as processor_module
from processor.src.exceptions import ProcessingError
from shared.models import Ortho, QueueTask, TaskTypeEnum
from shared.settings import settings


pytestmark = pytest.mark.unit


def _geotiff_task() -> QueueTask:
	return QueueTask(
		id=123,
		dataset_id=456,
		user_id='processor-user',
		priority=4,
		is_processing=True,
		claimed_by='worker-a',
		current_position=1,
		estimated_time=0.0,
		task_types=[TaskTypeEnum.geotiff],
	)


def test_process_geotiff_refreshes_auth_before_post_work_database_writes(monkeypatch, tmp_path):
	task = _geotiff_task()
	login_tokens = iter(['stage-token', 'ortho-write-token', 'processed-write-token'])
	ortho_write_tokens = []
	processed_write_tokens = []
	status_updates = []

	class _Query:
		def select(self, fields):
			return self

		def eq(self, field, value):
			return self

		def execute(self):
			return SimpleNamespace(data=[])

	class _Client:
		def table(self, name):
			assert name == settings.orthos_table
			return _Query()

		def __enter__(self):
			return self

		def __exit__(self, exc_type, exc, tb):
			return False

	def fake_pull(source, destination, token, dataset_id):
		assert dataset_id == task.dataset_id
		with open(destination, 'wb') as output:
			output.write(b'geotiff')

	def fake_standardise(source, destination, token, dataset_id):
		assert token == 'ortho-write-token'
		with open(destination, 'wb') as output:
			output.write(b'processed-geotiff')
		return True

	def fake_upsert_ortho_entry(**kwargs):
		ortho_write_tokens.append(kwargs['token'])
		return Ortho(
			dataset_id=task.dataset_id,
			ortho_file_name=f'{task.dataset_id}_ortho.tif',
			ortho_file_size=1,
			version=1,
		)

	def fake_upsert_processed_ortho_entry(**kwargs):
		processed_write_tokens.append(kwargs['token'])

	monkeypatch.setattr(
		geotiff_module,
		'login_verified',
		lambda username, password: (next(login_tokens), SimpleNamespace(id=task.user_id)),
	)
	monkeypatch.setattr(geotiff_module, 'use_client', lambda token: _Client())
	monkeypatch.setattr(geotiff_module, 'pull_file_from_storage_server', fake_pull)
	monkeypatch.setattr(geotiff_module, 'get_file_identifier', lambda path: 'sha256')
	monkeypatch.setattr(geotiff_module, 'cog_info', lambda path: SimpleNamespace(model_dump=lambda: {}))
	monkeypatch.setattr(geotiff_module, 'standardise_geotiff', fake_standardise)
	monkeypatch.setattr(geotiff_module, 'verify_geotiff', lambda *args: True)
	monkeypatch.setattr(geotiff_module, 'upsert_ortho_entry', fake_upsert_ortho_entry)
	monkeypatch.setattr(geotiff_module, 'upsert_processed_ortho_entry', fake_upsert_processed_ortho_entry)
	monkeypatch.setattr(
		geotiff_module,
		'update_status',
		lambda token, **kwargs: status_updates.append((token, kwargs)),
	)
	monkeypatch.setattr(geotiff_module.logger, 'info', lambda *args, **kwargs: None)
	monkeypatch.setattr(geotiff_module.logger, 'error', lambda *args, **kwargs: None)

	geotiff_module.process_geotiff(task, tmp_path)

	assert ortho_write_tokens == ['ortho-write-token']
	assert processed_write_tokens == ['processed-write-token']
	assert status_updates[0][0] == 'stage-token'
	assert status_updates[-1][0] == 'processed-write-token'
	assert status_updates[-1][1]['is_ortho_done'] is True


def test_process_task_keeps_refreshed_token_for_failure_bookkeeping(monkeypatch):
	task = _geotiff_task()
	refresh_tokens = iter(['stage-token', 'failure-token'])
	status_updates = []
	deleted_tasks = []

	monkeypatch.setattr(processor_module, 'verify_token', lambda token: SimpleNamespace(id=task.user_id))
	monkeypatch.setattr(processor_module, 'refresh_processor_token', lambda task, token=None: next(refresh_tokens))
	monkeypatch.setattr(
		processor_module,
		'process_geotiff',
		lambda task, processing_path: (_ for _ in ()).throw(RuntimeError('stage failed')),
	)
	monkeypatch.setattr(
		processor_module,
		'update_status',
		lambda token, **kwargs: status_updates.append((token, kwargs)),
	)
	monkeypatch.setattr(processor_module, 'create_processing_failure_issue', lambda **kwargs: None)
	monkeypatch.setattr(processor_module, '_notify_processing_result_safely', lambda *args, **kwargs: None)
	monkeypatch.setattr(processor_module, 'login', lambda username, password: 'delete-token')
	monkeypatch.setattr(
		processor_module,
		'delete_queue_task',
		lambda token, task: deleted_tasks.append((token, task.id)),
	)
	monkeypatch.setattr(processor_module.logger, 'info', lambda *args, **kwargs: None)
	monkeypatch.setattr(processor_module.logger, 'error', lambda *args, **kwargs: None)
	monkeypatch.setattr(processor_module.logger, 'warning', lambda *args, **kwargs: None)

	with pytest.raises(ProcessingError, match='stage failed'):
		processor_module.process_task(task, 'initial-token')

	assert len(status_updates) == 1
	status_token, status_fields = status_updates[0]
	assert status_token == 'failure-token'
	assert status_fields['dataset_id'] == task.dataset_id
	assert status_fields['current_status'] == processor_module.StatusEnum.idle
	assert status_fields['has_error'] is True
	assert 'stage failed' in status_fields['error_message']
	assert deleted_tasks == [('delete-token', task.id)]
