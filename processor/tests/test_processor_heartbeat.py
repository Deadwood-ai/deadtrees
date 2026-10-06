import pytest

import processor.src.processor as processor_module

pytestmark = pytest.mark.unit


class _Client:
	def __init__(self, rows, fail=False):
		self.rows = rows
		self.fail = fail

	def table(self, name):
		self.name = name
		return self

	def upsert(self, row, on_conflict=None):
		if self.fail:
			raise RuntimeError('database unavailable')
		self.rows.append((self.name, row, on_conflict))
		return self

	def execute(self):
		return None

	def __enter__(self):
		return self

	def __exit__(self, *_):
		return False


def test_heartbeat_is_written_at_most_once_a_minute(monkeypatch):
	rows = []
	clock = iter([1000.0, 1030.0, 1061.0])
	monkeypatch.setattr(processor_module, '_last_heartbeat_at', 0.0)
	monkeypatch.setattr(processor_module.time, 'monotonic', lambda: next(clock))
	monkeypatch.setattr(processor_module, 'use_client', lambda token: _Client(rows))

	for _ in range(3):
		processor_module._record_heartbeat('token', 'host-abc')

	assert [row['worker_id'] for _, row, _ in rows] == ['host-abc', 'host-abc']
	assert rows[0][0] == 'processor_heartbeats' and rows[0][2] == 'worker_id'


def test_heartbeat_failure_never_blocks_processing_and_is_retried(monkeypatch):
	rows = []
	clients = iter([_Client(rows, fail=True), _Client(rows)])
	monkeypatch.setattr(processor_module, '_last_heartbeat_at', 0.0)
	monkeypatch.setattr(processor_module.time, 'monotonic', lambda: 1000.0)
	monkeypatch.setattr(processor_module, 'use_client', lambda token: next(clients))

	processor_module._record_heartbeat('token', 'host-abc')
	processor_module._record_heartbeat('token', 'host-abc')

	assert len(rows) == 1
