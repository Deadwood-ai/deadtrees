"""Retention of abandoned chunk-upload bytes, on real files and receipts."""

from datetime import timedelta
import fcntl
import os
import time

import pytest

from api.src.upload.abandoned_uploads import cleanup_abandoned_uploads
from api.src.upload.chunk_session import locked_chunk_session


pytestmark = pytest.mark.unit
DAY = 24 * 60 * 60
NOW = time.time()


@pytest.fixture
def storage(tmp_path):
	sessions, archive, raw_images = tmp_path / 'sessions', tmp_path / 'archive', tmp_path / 'raw_images'
	archive.mkdir()
	raw_images.mkdir()
	return sessions, archive, raw_images


def start_upload(sessions, directory, upload_id, *, finalize=False):
	target = directory / f'{upload_id}.tmp'
	with locked_chunk_session(sessions, upload_id, target, 'owner', {'chunks_total': 1}) as session:
		session.accept(0, b'bytes')
		if finalize:
			session.begin_finalization()
	return target


def age(days, *paths):
	stamp = NOW - days * DAY
	for path in paths:
		os.utime(path, (stamp, stamp))


def run(storage, **kwargs):
	sessions, archive, raw_images = storage
	return cleanup_abandoned_uploads(sessions, [archive, raw_images], timedelta(days=7), now=NOW, **kwargs)


def test_deletes_only_old_abandoned_upload_bytes(storage):
	sessions, archive, raw_images = storage
	old_receiving = start_upload(sessions, raw_images, 'old-receiving')
	age(8, old_receiving, sessions / 'old-receiving.json')
	recent_receiving = start_upload(sessions, archive, 'recent-receiving')
	age(8, recent_receiving)
	age(1, sessions / 'recent-receiving.json')  # a chunk receipt was saved yesterday
	old_finalizing = start_upload(sessions, archive, 'old-finalizing', finalize=True)
	age(30, old_finalizing, sessions / 'old-finalizing.json')
	legacy = archive / 'legacy-without-receipt.tmp'
	legacy.write_bytes(b'legacy')
	age(8, legacy)
	recent_legacy = archive / 'recent-legacy.tmp'
	recent_legacy.write_bytes(b'legacy')
	unrelated = archive / '123_ortho.tif.tmp'
	unrelated.write_bytes(b'processor transfer')
	age(30, unrelated)

	assert sorted(run(storage)) == sorted([old_receiving, legacy])

	assert not old_receiving.exists()
	assert not legacy.exists()
	for kept in (recent_receiving, old_finalizing, recent_legacy, unrelated):
		assert kept.exists()
	# Receipts stay, so a late retry is told to restart instead of reusing the ID.
	assert (sessions / 'old-receiving.json').exists()
	with locked_chunk_session(sessions, 'old-receiving', old_receiving, 'owner', {'chunks_total': 1}) as session:
		with pytest.raises(Exception, match='data is missing'):
			session.begin_finalization()


def test_dry_run_keeps_files(storage):
	sessions, archive, _ = storage
	target = start_upload(sessions, archive, 'dry-run')
	age(8, target, sessions / 'dry-run.json')

	assert run(storage, dry_run=True) == [target]
	assert target.exists()


def test_skips_upload_with_request_in_progress(storage):
	sessions, archive, _ = storage
	target = start_upload(sessions, archive, 'busy')
	age(8, target, sessions / 'busy.json')

	with (sessions / 'busy.lock').open('a+b') as lock:
		fcntl.flock(lock, fcntl.LOCK_EX)
		assert run(storage) == []
	assert target.exists()
	assert run(storage) == [target]
