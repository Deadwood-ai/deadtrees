import datetime as dt
from pathlib import Path

from freidata import cron
from freidata.cron import fail_stale_uploads, find_stale_uploads, process_pending
from freidata.tests.conftest import FakeDB

NOW = dt.datetime(2026, 9, 30, 12, tzinfo=dt.timezone.utc)


def iso(hours_ago):
	return (NOW - dt.timedelta(hours=hours_ago)).isoformat()


def test_only_uploads_still_in_progress_can_become_stale():
	rows = [
		{'id': 1, 'upload_started_at': iso(13)},
		{'id': 2, 'upload_started_at': iso(1)},
		# A finished draft-only run clears upload_started_at.
		{'id': 3, 'upload_started_at': None},
	]
	stale = find_stale_uploads(rows, NOW, dt.timedelta(hours=12))
	assert [row['id'] for row in stale] == [1]


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


class _FakeInvenio:
	"""A FreiDATA draft that accepts every file upload."""

	def __init__(self, *_args, **_kwargs):
		self.files = {}

	def create_draft(self, _payload):
		return {'id': 'rec-1', 'links': {}, 'pids': {'doi': {'identifier': '10.1/draft'}}}

	def list_draft_files(self, _record_id):
		return {'entries': [{'key': k, **v} for k, v in self.files.items()]}

	def init_files(self, _record_id, keys):
		for key in keys:
			self.files[key] = {'status': 'pending'}

	def upload_file_content(self, _record_id, key, path):
		self.files[key] = {'status': 'completed', 'size': Path(path).stat().st_size}

	def commit_file(self, _record_id, _key):
		pass

	def get_file_entry(self, _record_id, key):
		return self.files[key]


def test_a_completed_draft_only_run_survives_the_stale_sweep(cfg, notifications, tmp_path, monkeypatch):
	from dataclasses import replace

	from freidata import pipeline

	cfg = replace(
		cfg, publish=False, create_community_review=False, auto_download=False, clean_zips=False, freidata_token='t'
	)
	db = FakeDB([{'id': 7, 'title': 'Draft', 'doi': None, 'status': 'pending', 'freidata_record_id': None}])
	db.full_info[7] = {'publication_id': 7, 'title': 'Draft', 'authors': [], 'datasets': []}
	(tmp_path / 'dataset.zip').write_bytes(b'bundle')
	monkeypatch.setattr(pipeline, 'InvenioClient', _FakeInvenio)
	monkeypatch.setattr(pipeline, 'validate_zips_against_db', lambda *_args: None)

	pipeline.run_publication_safe(cfg, db, tmp_path, 7)

	row = db.publications[0]
	assert row['status'] == 'uploading'
	assert row['upload_started_at'] is None
	# Far beyond the stale window, the finished draft is still not an interrupted upload.
	assert fail_stale_uploads(cfg, db, dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=30)) == []
	assert db.publications[0]['status'] == 'uploading'
	assert notifications == []
