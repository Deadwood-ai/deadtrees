from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

import processor.src.process_geotiff as process_geotiff_module
from shared.models import Ortho, QueueTask, TaskTypeEnum
from shared.settings import settings

pytestmark = pytest.mark.unit


def _task(dataset_id: int) -> QueueTask:
	return QueueTask(
		id=1,
		dataset_id=dataset_id,
		user_id='user',
		task_types=[TaskTypeEnum.geotiff],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
	)


@pytest.fixture
def stubbed_geotiff(monkeypatch):
	"""Stub every external boundary of process_geotiff and record what it touches."""
	calls = SimpleNamespace(pulls=[], upserted_names=[], versions=[], standardised=[], existing_rows=[])

	class _Query:
		def select(self, *_):
			return self

		def eq(self, *_):
			return self

		def execute(self):
			return SimpleNamespace(data=calls.existing_rows)

	@contextmanager
	def fake_use_client(_token):
		yield SimpleNamespace(table=lambda _name: _Query())

	def fake_pull(remote_path, local_path, token, dataset_id):
		calls.pulls.append((remote_path, Path(local_path).name))
		Path(local_path).write_bytes(b'archive ortho')

	def fake_upsert_ortho_entry(dataset_id, file_path, version, token, sha256, ortho_info):
		calls.upserted_names.append(file_path.name)
		calls.versions.append(version)
		assert file_path.read_bytes() == b'archive ortho'
		return Ortho(dataset_id=dataset_id, ortho_file_name=file_path.name, ortho_file_size=1, version=version)

	def fake_standardise(input_path, output_path, token, dataset_id):
		calls.standardised.append(Path(input_path).name)
		assert Path(input_path).read_bytes() == b'archive ortho'
		Path(output_path).write_bytes(b'standardised ortho')
		return True

	info = SimpleNamespace(model_dump=lambda: {})
	monkeypatch.setattr(process_geotiff_module, 'use_client', fake_use_client)
	monkeypatch.setattr(process_geotiff_module, 'pull_file_from_storage_server', fake_pull)
	monkeypatch.setattr(process_geotiff_module, 'upsert_ortho_entry', fake_upsert_ortho_entry)
	monkeypatch.setattr(process_geotiff_module, 'standardise_geotiff', fake_standardise)
	monkeypatch.setattr(process_geotiff_module, 'verify_geotiff', lambda *_: True)
	monkeypatch.setattr(process_geotiff_module, 'upsert_processed_ortho_entry', lambda **_: None)
	monkeypatch.setattr(process_geotiff_module, 'update_status', lambda *_, **__: None)
	monkeypatch.setattr(process_geotiff_module, 'get_file_identifier', lambda _path: 'sha')
	monkeypatch.setattr(process_geotiff_module, 'cog_info', lambda _path: info)
	monkeypatch.setattr(
		process_geotiff_module, '_refresh_processor_session', lambda _task: ('token', SimpleNamespace(id='user'))
	)
	return calls


@pytest.mark.parametrize('existing', [False, True])
def test_process_geotiff_pulls_the_archive_ortho_once(tmp_path, stubbed_geotiff, existing):
	dataset_id = 321
	if existing:
		stubbed_geotiff.existing_rows = [
			{'dataset_id': dataset_id, 'ortho_file_name': f'{dataset_id}_ortho.tif', 'ortho_file_size': 1, 'version': 4}
		]

	process_geotiff_module.process_geotiff(_task(dataset_id), tmp_path)

	archive_path = f'{settings.STORAGE_SERVER_DATA_PATH}/archive/{dataset_id}_ortho.tif'
	assert stubbed_geotiff.pulls == [(archive_path, f'{dataset_id}_ortho.tif')]
	# The ortho entry keeps the archive file name; standardisation reads the same pulled bytes.
	assert stubbed_geotiff.upserted_names == [f'{dataset_id}_ortho.tif']
	assert stubbed_geotiff.versions == [4 if existing else 1]
	assert stubbed_geotiff.standardised == [f'original_{dataset_id}_ortho.tif']
	# Only the standardised ortho is left for the downstream stages.
	assert sorted(p.name for p in tmp_path.iterdir()) == [f'{dataset_id}_ortho.tif']
	assert (tmp_path / f'{dataset_id}_ortho.tif').read_bytes() == b'standardised ortho'
