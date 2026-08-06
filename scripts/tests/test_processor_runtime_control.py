import argparse
import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / 'processor_runtime_control.py'
SPEC = importlib.util.spec_from_file_location('processor_runtime_control', SCRIPT)
assert SPEC is not None and SPEC.loader is not None
runtime_control = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime_control)


def _state(*, active_for_worker=None, active_without_owner=None):
	return {
		'worker_id': 'worker-a',
		'drain_request': {'request_id': 'request-a', 'requested_at': 'now'},
		'drain_ack': None,
		'active_for_worker': active_for_worker or [],
		'active_without_owner': active_without_owner or [],
	}


def test_wait_for_idle_allows_stopped_worker_without_active_rows(monkeypatch):
	monkeypatch.setattr(runtime_control, '_fetch_queue_state', lambda worker_id: _state())
	args = argparse.Namespace(
		timeout_seconds=1,
		poll_seconds=0,
		allow_unacknowledged_stopped_worker=True,
	)

	assert runtime_control.cmd_wait_for_idle(args) == 0


def test_wait_for_idle_rejects_stopped_worker_recovery_with_active_row(monkeypatch):
	monkeypatch.setattr(
		runtime_control,
		'_fetch_queue_state',
		lambda worker_id: _state(active_for_worker=[{'id': 123, 'claimed_by': worker_id}]),
	)
	monotonic_values = iter([0.0, 2.0])
	monkeypatch.setattr(runtime_control.time, 'monotonic', lambda: next(monotonic_values))
	monkeypatch.setattr(runtime_control.time, 'sleep', lambda seconds: None)
	args = argparse.Namespace(
		timeout_seconds=1,
		poll_seconds=0,
		allow_unacknowledged_stopped_worker=True,
	)

	assert runtime_control.cmd_wait_for_idle(args) == 1
