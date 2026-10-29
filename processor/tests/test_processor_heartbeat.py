import threading

import pytest

import processor.src.continuous_processor as continuous_processor_module
import processor.src.utils.heartbeat as heartbeat_module

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


class _StopAfter(threading.Event):
	"""Stops the heartbeat loop after a number of waits, without sleeping."""

	def __init__(self, beats):
		super().__init__()
		self.beats = beats
		self.waits = []

	def wait(self, timeout=None):
		self.waits.append(timeout)
		if len(self.waits) >= self.beats:
			self.set()
		return self.is_set()


def test_heartbeat_writes_every_minute_until_stopped(monkeypatch):
	rows = []
	monkeypatch.setattr(heartbeat_module, 'login', lambda user, password: 'token')
	monkeypatch.setattr(heartbeat_module, 'use_client', lambda token: _Client(rows))
	stop = _StopAfter(3)

	heartbeat_module.run_heartbeat('host-abc', stop)

	assert [row['worker_id'] for _, row, _ in rows] == ['host-abc'] * 3
	assert rows[0][0] == 'processor_heartbeats' and rows[0][2] == 'worker_id'
	assert stop.waits == [heartbeat_module.HEARTBEAT_INTERVAL_SECONDS] * 3


def test_heartbeat_failure_is_logged_and_retried(monkeypatch):
	rows = []
	clients = iter([_Client(rows, fail=True), _Client(rows)])
	warnings = []
	monkeypatch.setattr(heartbeat_module, 'login', lambda user, password: 'token')
	monkeypatch.setattr(heartbeat_module, 'use_client', lambda token: next(clients))
	monkeypatch.setattr(heartbeat_module.logger, 'warning', lambda message, *args, **kwargs: warnings.append(message))

	heartbeat_module.run_heartbeat('host-abc', _StopAfter(2))

	assert len(rows) == 1
	assert len(warnings) == 1 and 'database unavailable' in warnings[0]


def test_failed_login_does_not_stop_the_heartbeat(monkeypatch):
	rows = []
	logins = iter([RuntimeError('auth down'), 'token'])

	def login(user, password):
		result = next(logins)
		if isinstance(result, Exception):
			raise result
		return result

	monkeypatch.setattr(heartbeat_module, 'login', login)
	monkeypatch.setattr(heartbeat_module, 'use_client', lambda token: _Client(rows))
	monkeypatch.setattr(heartbeat_module.logger, 'warning', lambda *args, **kwargs: None)

	heartbeat_module.run_heartbeat('host-abc', _StopAfter(2))

	assert len(rows) == 1


def test_continuous_worker_starts_the_heartbeat_for_its_worker_id(monkeypatch):
	started = []

	class _Stop(Exception):
		pass

	monkeypatch.setattr(continuous_processor_module, 'get_worker_id', lambda: 'host-test')
	monkeypatch.setattr(continuous_processor_module, 'start_heartbeat', started.append)
	monkeypatch.setattr(continuous_processor_module, 'use_data_disk_for_temp_files', lambda: None)
	monkeypatch.setattr(continuous_processor_module, 'processing_email_config_problem', lambda: None)

	def stop_at_cleanup(username, password):
		raise _Stop

	monkeypatch.setattr(continuous_processor_module, 'login', stop_at_cleanup)
	monkeypatch.setattr(continuous_processor_module, 'cleanup_orphaned_resources', lambda token: None)
	monkeypatch.setattr(continuous_processor_module, 'is_drain_requested', lambda: (_ for _ in ()).throw(_Stop()))
	monkeypatch.setattr(continuous_processor_module.logger, 'info', lambda *args, **kwargs: None)
	monkeypatch.setattr(continuous_processor_module.logger, 'error', lambda *args, **kwargs: None)

	with pytest.raises(_Stop):
		continuous_processor_module.run_continuous()

	assert started == ['host-test']
