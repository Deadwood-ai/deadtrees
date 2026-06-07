from types import SimpleNamespace

import pytest
from shapely.geometry import Polygon

from shared.labels import upload_geometry_chunk
from shared.models import DeadwoodGeometry


class _FakeSelect:
	"""Models ``select('id', count='exact').eq('label_id', ...).execute()``."""

	def __init__(self, table):
		self._table = table

	def eq(self, field, value):
		return self

	def execute(self):
		return SimpleNamespace(count=len(self._table.rows))


class _FakeInsert:
	def __init__(self, table, records):
		self._table = table
		self._records = records

	def execute(self):
		t = self._table
		outcome = t.behavior[t.insert_attempts] if t.insert_attempts < len(t.behavior) else 'ok'
		t.insert_attempts += 1
		if outcome == 'fail':
			# Connection dropped before the write committed: no rows added.
			raise Exception('The write operation timed out')
		if outcome == 'commit_then_fail':
			# Rows committed server-side, but the response was lost.
			t.rows.extend(self._records)
			raise Exception('Server disconnected without sending a response.')
		t.rows.extend(self._records)
		return None


class _FakeTable:
	def __init__(self, behavior):
		self.behavior = behavior
		self.rows = []
		self.insert_attempts = 0

	def select(self, *args, **kwargs):
		return _FakeSelect(self)

	def insert(self, records):
		return _FakeInsert(self, records)


class _FakeClient:
	def __init__(self, behavior):
		self._table = _FakeTable(behavior)

	def table(self, name):
		return self._table


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
	monkeypatch.setattr('shared.retry.time.sleep', lambda d: None)


def _polygon():
	return Polygon([(0, 0), (0, 1), (1, 1), (1, 0), (0, 0)])


def _upload(client):
	upload_geometry_chunk(
		client,
		table='v2_deadwood_geometries',
		GeometryModel=DeadwoodGeometry,
		label_id=1,
		geometries=[_polygon()],
		properties=None,
		token='token',
	)


def test_upload_geometry_chunk_retries_transient_error():
	client = _FakeClient(behavior=['fail', 'fail', 'ok'])

	_upload(client)

	assert client._table.insert_attempts == 3
	assert len(client._table.rows) == 1


def test_upload_geometry_chunk_gives_up_after_max_attempts():
	client = _FakeClient(behavior=['fail', 'fail', 'fail', 'fail'])

	with pytest.raises(Exception, match='Error uploading geometry chunk'):
		_upload(client)

	# Default max_attempts is 4.
	assert client._table.insert_attempts == 4
	assert client._table.rows == []


def test_upload_geometry_chunk_does_not_duplicate_when_commit_response_lost():
	"""The committed-but-response-lost case must not insert the chunk twice."""
	client = _FakeClient(behavior=['commit_then_fail'])

	_upload(client)

	# Insert was issued once; the retry detected the rows already landed and
	# skipped re-inserting, so there is exactly one geometry, not two.
	assert client._table.insert_attempts == 1
	assert len(client._table.rows) == 1
