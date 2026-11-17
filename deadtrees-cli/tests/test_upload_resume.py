"""The CLI continues an unfinished upload of the same file (DT-1567), without a server."""

import hashlib
import io

import httpx
import pytest

from deadtrees_cli import data
from deadtrees_cli.data import DataCommands, _find_resumable_upload

pytestmark = pytest.mark.unit
CHUNK = 4
CONTENT = b'aaaabbbbccccdd'
FORM = {'chunks_total': '4', 'license': 'CC BY', 'platform': 'drone', 'authors': ['A'], 'data_access': 'public'}
CONTRACT = {'file_name': 'flight.zip', 'license': 'CC BY', 'platform': 'drone', 'authors': ['A'], 'data_access': 'public', 'aquisition_year': None}


def unfinished(parts, **overrides):
	"""An unfinished upload whose received chunks hold `parts`."""
	chunks = [{'size': len(part), 'sha256': hashlib.sha256(part).hexdigest()} for part in parts]
	return {
		'upload_id': 'up-1',
		'state': 'receiving',
		'chunks_total': 4,
		'chunks_received': len(parts),
		'last_chunk': chunks[-1] if chunks else None,
		'chunks': chunks,
		'contract': {**CONTRACT, **overrides},
	}


def find(uploads, form=FORM, status=200):
	def handler(request):
		if request.url.path.endswith('/datasets/uploads'):
			listed = [{k: v for k, v in upload.items() if k != 'chunks'} for upload in uploads] if status == 200 else uploads
			return httpx.Response(status, json=listed)
		upload_id = request.url.path.rsplit('/', 1)[-1]
		return httpx.Response(200, json=next(upload for upload in uploads if upload['upload_id'] == upload_id))

	transport = httpx.MockTransport(handler)
	with httpx.Client(transport=transport) as client:
		return _find_resumable_upload(client, 'token', io.BytesIO(CONTENT), 'flight.zip', CHUNK, form)


def test_continues_after_the_received_chunks_of_the_same_file():
	assert find([unfinished([b'aaaa', b'bbbb'])]) == ('up-1', 2)


def test_single_author_given_as_text_still_matches():
	assert find([unfinished([b'aaaa', b'bbbb'])], form={**FORM, 'authors': 'A'}) == ('up-1', 2)


def test_resends_the_last_chunk_when_only_its_reply_was_lost():
	assert find([unfinished([b'aaaa', b'bbbb', b'cccc', b'dd'])]) == ('up-1', 3)


@pytest.mark.parametrize(
	'upload',
	[
		unfinished([b'aaaa', b'xxxx']),  # different last chunk
		unfinished([b'xxxx', b'bbbb']),  # different earlier chunk
		unfinished([b'aaaa', b'bbbb'], file_name='other.zip'),
		unfinished([b'aaaa', b'bbbb'], authors=['B']),
		unfinished([b'aaaa', b'bbbb'], aquisition_year=2024),
		{**unfinished([b'aaaa', b'bbbb']), 'state': 'finalizing'},
		{**unfinished([b'aaaa', b'bbbb']), 'chunks_total': 5},
	],
)
def test_starts_fresh_for_any_other_upload(upload):
	assert find([upload]) is None


def test_starts_fresh_against_an_api_without_resume():
	assert find({'detail': 'Not Found'}, status=404) is None


def test_chunk_is_retried_after_network_and_busy_errors(monkeypatch):
	monkeypatch.setattr(data.time, 'sleep', lambda _seconds: None)
	replies = iter([httpx.ConnectError('down'), httpx.Response(503), httpx.Response(200, json={'id': 42})])

	def handler(request):
		reply = next(replies)
		if isinstance(reply, Exception):
			raise reply
		return reply

	commands = DataCommands()
	commands._token = 'token'
	with httpx.Client(transport=httpx.MockTransport(handler)) as client:
		response = commands._send_chunk(client, {'chunk_index': '0'}, {'file': ('f', b'x', 'application/octet-stream')})
	assert response.json() == {'id': 42}


def test_rejected_file_is_not_retried(monkeypatch):
	monkeypatch.setattr(data.time, 'sleep', lambda _seconds: pytest.fail('retried a rejected file'))
	commands = DataCommands()
	commands._token = 'token'
	transport = httpx.MockTransport(lambda request: httpx.Response(400, json={'detail': 'bad zip'}))
	with httpx.Client(transport=transport) as client, pytest.raises(httpx.HTTPStatusError):
		commands._send_chunk(client, {'chunk_index': '0'}, {'file': ('f', b'x', 'application/octet-stream')})
