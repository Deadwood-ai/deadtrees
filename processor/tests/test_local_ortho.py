from pathlib import Path

from shared.logging import LogContext, LogCategory
from shared.settings import settings

from processor.src.utils.local_ortho import ensure_local_ortho


def test_ensure_local_ortho_prefers_existing_local_file(tmp_path, monkeypatch):
	local_path = tmp_path / '123_ortho.tif'
	local_path.write_text('already standardized')
	pull_calls = []

	def fake_pull(*args, **kwargs):
		pull_calls.append((args, kwargs))

	monkeypatch.setattr('processor.src.utils.local_ortho.pull_file_from_storage_server', fake_pull)

	result = ensure_local_ortho(
		local_path=local_path,
		ortho_file_name='123_ortho.tif',
		token='token',
		dataset_id=123,
		log_context=LogContext(category=LogCategory.ORTHO, dataset_id=123, token='token'),
	)

	assert result == local_path
	assert pull_calls == []


def test_ensure_local_ortho_falls_back_to_archive_pull(tmp_path, monkeypatch):
	local_path = tmp_path / '456_ortho.tif'
	pull_calls = []

	def fake_pull(remote_file_path: str, local_file_path: str, token: str, dataset_id: int):
		pull_calls.append((remote_file_path, local_file_path, token, dataset_id))
		Path(local_file_path).write_text('downloaded from archive')

	monkeypatch.setattr('processor.src.utils.local_ortho.pull_file_from_storage_server', fake_pull)

	result = ensure_local_ortho(
		local_path=local_path,
		ortho_file_name='456_ortho.tif',
		token='token',
		dataset_id=456,
		log_context=LogContext(category=LogCategory.ORTHO, dataset_id=456, token='token'),
	)

	assert result == local_path
	assert local_path.read_text() == 'downloaded from archive'
	expected_remote_path = f'{settings.STORAGE_SERVER_DATA_PATH}/archive/456_ortho.tif'
	assert pull_calls == [(expected_remote_path, str(local_path), 'token', 456)]
