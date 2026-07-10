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


_STATEMENT_TIMEOUT = "{'message': 'canceling statement due to statement timeout', 'code': '57014'}"


class _GatedTable:
	"""Insert succeeds only for batches of ``max_ok_batch`` rows or fewer; larger
	batches raise a Postgres statement timeout, which the uploader must resolve by
	splitting the batch."""

	def __init__(self, max_ok_batch):
		self.max_ok_batch = max_ok_batch
		self.rows = []
		self.insert_attempts = 0
		self.timeout_count = 0
		self.ok_batches = []

	def select(self, *args, **kwargs):
		return _FakeSelect(self)

	def insert(self, records):
		return _GatedInsert(self, records)


class _GatedInsert:
	def __init__(self, table, records):
		self._table = table
		self._records = list(records)

	def execute(self):
		t = self._table
		t.insert_attempts += 1
		if len(self._records) > t.max_ok_batch:
			t.timeout_count += 1
			raise Exception(_STATEMENT_TIMEOUT)
		t.rows.extend(self._records)
		t.ok_batches.append(len(self._records))
		return None


class _GatedClient:
	def __init__(self, max_ok_batch):
		self._table = _GatedTable(max_ok_batch)

	def table(self, name):
		return self._table


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
	monkeypatch.setattr('shared.retry.time.sleep', lambda d: None)


def _polygon():
	return Polygon([(0, 0), (0, 1), (1, 1), (1, 0), (0, 0)])


def _upload(client, count=1):
	upload_geometry_chunk(
		client,
		table='v2_deadwood_geometries',
		GeometryModel=DeadwoodGeometry,
		label_id=1,
		geometries=[_polygon() for _ in range(count)],
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


def test_upload_splits_batch_on_statement_timeout():
	"""A batch that hits statement_timeout is halved recursively until it fits."""
	client = _GatedClient(max_ok_batch=1)  # only single-row inserts succeed

	_upload(client, count=4)

	t = client._table
	# All four geometries landed, committed one row at a time.
	assert len(t.rows) == 4
	assert t.ok_batches == [1, 1, 1, 1]
	# The oversized batches — insert(4), then insert(2) for each half — each timed
	# out exactly once (no wasteful retries of the same too-large statement).
	assert t.timeout_count == 3


def test_upload_splits_only_as_far_as_needed():
	"""Splitting stops as soon as a sub-batch fits the budget."""
	client = _GatedClient(max_ok_batch=2)  # batches of 2 succeed

	_upload(client, count=4)

	t = client._table
	assert len(t.rows) == 4
	# insert(4) times out once, then the two halves of 2 both commit.
	assert t.timeout_count == 1
	assert t.ok_batches == [2, 2]


def test_upload_reraises_when_single_record_still_times_out():
	"""A single geometry that still times out is a real error, not something to split."""
	client = _GatedClient(max_ok_batch=0)  # even one row times out

	with pytest.raises(Exception, match='Error uploading geometry chunk'):
		_upload(client, count=2)

	# Nothing committed, and it did not spin forever: 2 -> 1 (still fails) -> raise.
	assert client._table.rows == []
