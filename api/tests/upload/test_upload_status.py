"""Resume view of chunk receipts, without external services."""

import json
import os

import pytest

from api.src.upload.chunk_session import locked_chunk_session
from api.src.upload.upload_status import list_unfinished_uploads, read_upload_status


pytestmark = pytest.mark.unit
CONTRACT = {'chunks_total': 3, 'file_name': 'flight.zip', 'authors': ['A'], 'upload_type': 'raw_images_zip'}


@pytest.fixture
def dirs(tmp_path):
	sessions, upload_dir = tmp_path / 'sessions', tmp_path / 'raw'
	upload_dir.mkdir()
	return sessions, upload_dir


def send(dirs, upload_id, index, content, user='owner', contract=CONTRACT):
	sessions, upload_dir = dirs
	with locked_chunk_session(sessions, upload_id, upload_dir / f'{upload_id}.tmp', user, contract) as session:
		return session.accept(index, content)


def status(dirs, upload_id, user='owner'):
	sessions, upload_dir = dirs
	return read_upload_status(sessions, upload_id, user, [upload_dir])


def test_reports_received_chunks_and_contract(dirs):
	send(dirs, 'up-1', 0, b'first')
	send(dirs, 'up-1', 1, b'second')
	result = status(dirs, 'up-1')
	assert result.state == 'receiving'
	assert (result.chunks_total, result.chunks_received, result.bytes_received) == (3, 2, 11)
	assert result.last_chunk.size == 6
	assert [chunk.size for chunk in result.chunks] == [5, 6]
	assert result.contract == CONTRACT
	assert result.response is None


def test_other_users_and_unknown_ids_see_nothing(dirs):
	send(dirs, 'up-1', 0, b'first')
	assert status(dirs, 'up-1', user='someone-else') is None
	assert status(dirs, 'missing') is None


def test_deleted_bytes_mark_the_upload_expired(dirs):
	send(dirs, 'up-1', 0, b'first')
	(dirs[1] / 'up-1.tmp').unlink()
	assert status(dirs, 'up-1').state == 'expired'


def test_complete_upload_returns_its_dataset(dirs):
	sessions, upload_dir = dirs
	contract = {**CONTRACT, 'chunks_total': 1}
	with locked_chunk_session(sessions, 'up-1', upload_dir / 'up-1.tmp', 'owner', contract) as session:
		assert session.accept(0, b'only') is None
		session.begin_finalization()
		session.complete({'id': 42})
	result = status(dirs, 'up-1')
	assert (result.state, result.response) == ('complete', {'id': 42})


def test_receipt_from_before_resume_learns_its_contract(dirs):
	sessions, _ = dirs
	send(dirs, 'up-1', 0, b'first')
	receipt_path = sessions / 'up-1.json'
	legacy = json.loads(receipt_path.read_text())
	del legacy['contract'], legacy['created_at']
	receipt_path.write_text(json.dumps(legacy))
	assert status(dirs, 'up-1').contract is None
	send(dirs, 'up-1', 1, b'second')
	assert status(dirs, 'up-1').contract == CONTRACT


def test_unfinished_list_keeps_only_recent_resumable_uploads_of_the_caller(dirs):
	sessions, upload_dir = dirs
	send(dirs, 'old', 0, b'x')
	send(dirs, 'recent', 0, b'x')
	send(dirs, 'foreign', 0, b'x', user='someone-else')
	send(dirs, 'gone', 0, b'x')
	(upload_dir / 'gone.tmp').unlink()
	contract = {**CONTRACT, 'chunks_total': 1}
	with locked_chunk_session(sessions, 'done', upload_dir / 'done.tmp', 'owner', contract) as session:
		session.accept(0, b'x')
		session.begin_finalization()
		session.complete({'id': 1})
	now = os.stat(sessions / 'recent.json').st_mtime
	os.utime(sessions / 'old.json', (now - 10 * 86400, now - 10 * 86400))
	found = list_unfinished_uploads(sessions, 'owner', [upload_dir], max_age_seconds=7 * 86400, now=now)
	assert [upload.upload_id for upload in found] == ['recent']
	assert found[0].chunks is None


def test_unfinished_list_without_sessions_directory(tmp_path):
	assert list_unfinished_uploads(tmp_path / 'missing', 'owner', [tmp_path], 3600) == []
