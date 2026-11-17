"""Filesystem recovery and process locking without external services."""

from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context

import pytest
from fastapi import HTTPException

from api.src.upload.chunk_session import locked_chunk_session


pytestmark = pytest.mark.unit
CONTRACT = {'chunks_total': 2, 'filename': 'image.tif'}


def open_session(tmp_path, user='owner', contract=None):
	return locked_chunk_session(tmp_path / 'sessions', 'upload-id', tmp_path / 'upload.tmp', user, contract or CONTRACT)


def attempt_in_another_process(tmp_path):
	from api.src.upload import chunk_session

	chunk_session.LOCK_WAIT_SECONDS = 0.2
	try:
		with open_session(tmp_path) as session:
			return session.accept(0, b'first')
	except HTTPException as error:
		return error.status_code


def test_worker_lock_is_shared_and_released(tmp_path):
	with ProcessPoolExecutor(max_workers=1, mp_context=get_context('spawn')) as pool:
		with open_session(tmp_path) as session:
			session.accept(0, b'first')
			# Past its wait, a blocked request answers 503.
			assert pool.submit(attempt_in_another_process, tmp_path).result(timeout=20) == 503
		assert pool.submit(attempt_in_another_process, tmp_path).result(timeout=20) == {
			'message': 'Chunk 0 of 2 received'
		}
	assert (tmp_path / 'upload.tmp').read_bytes() == b'first'


@pytest.mark.parametrize('uncommitted', [b'par', b'last'])
def test_recovers_partial_or_complete_append_without_receipt(tmp_path, uncommitted):
	with open_session(tmp_path) as session:
		session.accept(0, b'first')
	with (tmp_path / 'upload.tmp').open('ab') as output:
		output.write(uncommitted)
	with open_session(tmp_path) as session:
		assert session.accept(1, b'last') is None
		session.begin_finalization()
		session.complete({'id': 123})
	assert (tmp_path / 'upload.tmp').read_bytes() == b'firstlast'


def test_lost_final_response_survives_new_session_and_file_move(tmp_path):
	with open_session(tmp_path) as session:
		session.accept(0, b'first')
		session.accept(1, b'last')
		session.begin_finalization()
		(tmp_path / 'upload.tmp').rename(tmp_path / '123_ortho.tif')
		session.complete({'id': 123})
	with open_session(tmp_path) as session:
		assert session.accept(1, b'last') == {'id': 123}
		with pytest.raises(HTTPException, match='Chunk content changed'):
			session.accept(1, b'other')
	assert not (tmp_path / 'upload.tmp').exists()


def test_interrupted_finalization_never_starts_again(tmp_path):
	with open_session(tmp_path) as session:
		session.accept(0, b'first')
		session.accept(1, b'last')
		session.begin_finalization()
		# The worker disappears after a DB insert or rename, before its receipt.
		(tmp_path / 'upload.tmp').rename(tmp_path / '123_ortho.tif')
	with open_session(tmp_path) as session:
		with pytest.raises(HTTPException, match='finalization was interrupted') as error:
			session.accept(1, b'last')
		assert error.value.status_code == 409
	assert not (tmp_path / 'upload.tmp').exists()


def test_owner_and_contract_are_bound_to_upload_id(tmp_path):
	with open_session(tmp_path) as session:
		session.accept(0, b'first')
	for user, contract in [('other', CONTRACT), ('owner', {**CONTRACT, 'filename': 'changed.zip'})]:
		with pytest.raises(HTTPException) as error:
			with open_session(tmp_path, user, contract):
				pytest.fail('Conflicting upload accepted')
		assert error.value.status_code == 409
	assert (tmp_path / 'upload.tmp').read_bytes() == b'first'


def test_legacy_untracked_bytes_are_not_overwritten(tmp_path):
	(tmp_path / 'upload.tmp').write_bytes(b'legacy upload')
	with pytest.raises(HTTPException, match='no retry receipts'):
		with open_session(tmp_path):
			pytest.fail('Legacy upload accepted')
	assert (tmp_path / 'upload.tmp').read_bytes() == b'legacy upload'


def test_missing_committed_bytes_prevent_finalization(tmp_path):
	with open_session(tmp_path) as session:
		session.accept(0, b'first')
		session.accept(1, b'last')
	(tmp_path / 'upload.tmp').write_bytes(b'first')
	with open_session(tmp_path) as session:
		assert session.accept(1, b'last') is None
		with pytest.raises(HTTPException, match='data is missing'):
			session.begin_finalization()


def test_rejected_validation_leaves_upload_retryable(tmp_path):
	checked = []

	def reject(path):
		checked.append(path.read_bytes())
		raise HTTPException(status_code=400, detail='Unsupported ZIP compression')

	for _ in range(2):
		with open_session(tmp_path) as session:
			session.accept(0, b'first')
			assert session.accept(1, b'last') is None
			with pytest.raises(HTTPException, match='Unsupported ZIP compression'):
				session.begin_finalization(validate=reject)
	assert checked == [b'firstlast', b'firstlast']
	with open_session(tmp_path) as session:
		assert session.accept(1, b'last') is None
		session.begin_finalization(validate=lambda _path: None)
		session.complete({'id': 123})


def test_file_chunk_matches_bytes_chunk_on_retry(tmp_path):
	import io

	with open_session(tmp_path) as session:
		session.accept(0, io.BytesIO(b'first'))
	# A retry of the same chunk as bytes has the same receipt.
	with open_session(tmp_path) as session:
		assert session.accept(0, b'first') == {'message': 'Chunk 0 of 2 received'}
	assert (tmp_path / 'upload.tmp').read_bytes() == b'first'


def test_oversized_chunk_is_rejected_before_writing(tmp_path, monkeypatch):
	import io

	from api.src.upload import chunk_session

	monkeypatch.setattr(chunk_session, 'MAX_CHUNK_BYTES', 8)
	monkeypatch.setattr(chunk_session, 'COPY_BLOCK_BYTES', 3)
	with open_session(tmp_path) as session:
		with pytest.raises(HTTPException) as error:
			session.accept(0, io.BytesIO(b'123456789'))
		assert error.value.status_code == 413
		# A chunk of exactly the limit is accepted, copied in small blocks.
		assert session.accept(0, io.BytesIO(b'12345678')) == {'message': 'Chunk 0 of 2 received'}
	assert (tmp_path / 'upload.tmp').read_bytes() == b'12345678'


PARALLEL = {'chunks_total': 3, 'filename': 'image.tif', 'chunk_size': 4}


def test_declared_chunk_size_accepts_chunks_in_any_order(tmp_path):
	"""DT-1568: parallel clients send chunks out of order; each lands at index * chunk_size."""
	for index, data in [(2, b'cc'), (0, b'aaaa')]:
		with open_session(tmp_path, contract=PARALLEL) as session:
			assert session.accept(index, data) == {'message': f'Chunk {index} of 3 received'}
	with open_session(tmp_path, contract=PARALLEL) as session:
		# A repeated chunk is acknowledged without writing; the missing one completes the set.
		assert session.accept(2, b'cc') == {'message': 'Chunk 2 of 3 received'}
		assert session.accept(1, b'bbbb') is None
		session.begin_finalization()
		session.complete({'id': 7})
	assert (tmp_path / 'upload.tmp').read_bytes() == b'aaaabbbbcc'
	with open_session(tmp_path, contract=PARALLEL) as session:
		assert session.accept(0, b'aaaa') == {'id': 7}


@pytest.mark.parametrize('index, data', [(0, b'aaa'), (1, b'bbbbb'), (2, b'ccccc')])
def test_chunks_must_match_the_declared_size(tmp_path, index, data):
	with open_session(tmp_path, contract=PARALLEL) as session:
		with pytest.raises(HTTPException, match='declared chunk size') as error:
			session.accept(index, data)
		assert error.value.status_code == 409


def test_uncommitted_parallel_write_is_overwritten_by_its_retry(tmp_path):
	with open_session(tmp_path, contract=PARALLEL) as session:
		session.accept(0, b'aaaa')
	# A worker wrote chunk 1 and died before its receipt.
	with (tmp_path / 'upload.tmp').open('r+b') as output:
		output.seek(4)
		output.write(b'XXXX')
	with open_session(tmp_path, contract=PARALLEL) as session:
		session.accept(2, b'cc')
		assert session.accept(1, b'bbbb') is None
		session.begin_finalization()
	assert (tmp_path / 'upload.tmp').read_bytes() == b'aaaabbbbcc'


def wait_for_lock_in_another_process(tmp_path):
	with open_session(tmp_path) as session:
		return session.accept(1, b'last')


def test_a_parallel_request_waits_for_the_lock_instead_of_failing(tmp_path):
	import time

	with ProcessPoolExecutor(max_workers=1, mp_context=get_context('spawn')) as pool:
		with open_session(tmp_path) as session:
			session.accept(0, b'first')
			waiting = pool.submit(wait_for_lock_in_another_process, tmp_path)
			time.sleep(1)
			assert not waiting.done()
		assert waiting.result(timeout=20) is None
