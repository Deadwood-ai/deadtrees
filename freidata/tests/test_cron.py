import datetime as dt
from pathlib import Path

from freidata import cron
from freidata.cron import fail_stale_uploads, find_stale_uploads, process_pending
from freidata.tests.conftest import FakeDB

NOW = dt.datetime(2026, 9, 30, 12, tzinfo=dt.timezone.utc)


def iso(hours_ago):
	return (NOW - dt.timedelta(hours=hours_ago)).isoformat()


def test_stale_uploads_are_found_by_upload_start_or_creation_time():
	rows = [
		{'id': 1, 'upload_started_at': iso(13), 'created_at': iso(100)},
		{'id': 2, 'upload_started_at': iso(1), 'created_at': iso(100)},
		# Started before upload_started_at existed.
		{'id': 3, 'upload_started_at': None, 'created_at': iso(30)},
		{'id': 4, 'upload_started_at': None, 'created_at': '2026-09-30T11:00:00Z'},
	]
	stale = find_stale_uploads(rows, NOW, dt.timedelta(hours=12))
	assert [row['id'] for row in stale] == [1, 3]


def test_interrupted_uploads_become_errors_and_are_reported(cfg, notifications):
	db = FakeDB([
		{'id': 1, 'title': 'Killed', 'status': 'uploading', 'upload_started_at': iso(13), 'created_at': iso(20), 'freidata_record_id': 'r1'},
		{'id': 2, 'title': 'Running', 'status': 'uploading', 'upload_started_at': iso(1), 'created_at': iso(20), 'freidata_record_id': None},
		{'id': 3, 'title': 'Queued', 'status': 'pending', 'upload_started_at': None, 'created_at': iso(20), 'freidata_record_id': None},
	])

	assert fail_stale_uploads(cfg, db, NOW) == [1]

	assert [row['status'] for row in db.publications] == ['error', 'uploading', 'pending']
	assert [(n['pub_id'], n['record_id']) for n in notifications] == [(1, 'r1')]
	assert 'Upload interrupted' in notifications[0]['error_message']


def test_the_download_folder_is_removed_after_each_publication(cfg, monkeypatch):
	folders = []

	def fake_run(_cfg, _db, folder, pub_id):
		folders.append(folder)
		(folder / 'dataset.zip').write_bytes(b'bundle')
		if pub_id == 2:
			raise RuntimeError('upload failed')

	monkeypatch.setattr(cron, 'run_publication_safe', fake_run)

	process_pending(cfg, FakeDB([]), [{'id': 1, 'title': 'ok'}, {'id': 2, 'title': 'fails'}])

	assert len(folders) == 2
	assert not any(Path(folder).exists() for folder in folders)
