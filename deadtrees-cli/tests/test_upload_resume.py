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


def unfinished(received, last, **overrides):
	return {
		'upload_id': 'up-1',
		'state': 'receiving',
		'chunks_total': 4,
		'chunks_received': received,
		'last_chunk': {'size': len(last), 'sha256': hashlib.sha256(last).hexdigest()} if last else None,
		'contract': {**CONTRACT, **overrides},
	}


def find(uploads, form=FORM, status=200):
	transport = httpx.MockTransport(lambda request: httpx.Response(status, json=uploads))
	with httpx.Client(transport=transport) as client:
		return _find_resumable_upload(client, 'token', io.BytesIO(CONTENT), 'flight.zip', CHUNK, form)


def test_continues_after_the_received_chunks_of_the_same_file():
	assert find([unfinished(2, b'bbbb')]) == ('up-1', 2)


def test_single_author_given_as_text_still_matches():
	assert find([unfinished(2, b'bbbb')], form={**FORM, 'authors': 'A'}) == ('up-1', 2)


def test_resends_the_last_chunk_when_only_its_reply_was_lost():
	assert find([unfinished(4, b'dd')]) == ('up-1', 3)


@pytest.mark.parametrize(
	'upload',
	[
		unfinished(2, b'xxxx'),  # different bytes
		unfinished(2, b'bbbb', file_name='other.zip'),
		unfinished(2, b'bbbb', authors=['B']),
		unfinished(2, b'bbbb', aquisition_year=2024),
		{**unfinished(2, b'bbbb'), 'state': 'finalizing'},
		{**unfinished(2, b'bbbb'), 'chunks_total': 5},
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
