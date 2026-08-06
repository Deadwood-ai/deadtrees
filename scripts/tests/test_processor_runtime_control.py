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
	monkeypatch.setattr(runtime_control, '_login', lambda: 'token')
	monkeypatch.setattr(runtime_control, '_fetch_queue_state', lambda worker_id, **kwargs: _state())
	args = argparse.Namespace(
		timeout_seconds=1,
		poll_seconds=0,
		allow_unacknowledged_stopped_worker=True,
	)

	assert runtime_control.cmd_wait_for_idle(args) == 0


def test_wait_for_idle_rejects_stopped_worker_recovery_with_active_row(monkeypatch):
	monkeypatch.setattr(runtime_control, '_login', lambda: 'token')
	monkeypatch.setattr(
		runtime_control,
		'_fetch_queue_state',
		lambda worker_id, **kwargs: _state(active_for_worker=[{'id': 123, 'claimed_by': worker_id}]),
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


def test_wait_for_idle_reuses_login_and_skips_waiting_preview(monkeypatch):
	login_calls = []
	preview_calls = []
	monkeypatch.setattr(runtime_control, '_login', lambda: login_calls.append(True) or 'token')
	monkeypatch.setattr(
		runtime_control,
		'_load_drain_state',
		lambda: (
			{'request_id': 'request-a', 'requested_at': 'now'},
			{'request_id': 'request-a', 'requested_at': 'now'},
		),
	)
	monkeypatch.setattr(runtime_control, '_fetch_queue_rows', lambda token, **kwargs: [])
	monkeypatch.setattr(
		runtime_control,
		'_fetch_waiting_count_preview',
		lambda token: preview_calls.append(True) or (_ for _ in ()).throw(RuntimeError('preview unavailable')),
	)
	args = argparse.Namespace(timeout_seconds=1, poll_seconds=0, allow_unacknowledged_stopped_worker=False)

	assert runtime_control.cmd_wait_for_idle(args) == 0
	assert len(login_calls) == 1
	assert preview_calls == []


def test_wait_for_idle_refreshes_expired_token_once(monkeypatch):
	tokens = iter(['expired-token', 'fresh-token'])
	login_calls = []
	seen_tokens = []
	monkeypatch.setattr(runtime_control, '_login', lambda: login_calls.append(True) or next(tokens))

	def fetch_state(worker_id, *, token, include_waiting_preview):
		seen_tokens.append(token)
		assert include_waiting_preview is False
		if token == 'expired-token':
			raise runtime_control.AuthenticationExpiredError('expired')
		return {
			**_state(),
			'drain_ack': {'request_id': 'request-a', 'requested_at': 'now'},
		}

	monkeypatch.setattr(runtime_control, '_fetch_queue_state', fetch_state)
	args = argparse.Namespace(timeout_seconds=1, poll_seconds=0, allow_unacknowledged_stopped_worker=False)

	assert runtime_control.cmd_wait_for_idle(args) == 0
	assert len(login_calls) == 2
	assert seen_tokens == ['expired-token', 'fresh-token']


def test_wait_for_idle_reuses_login_across_multiple_polls(monkeypatch):
	login_calls = []
	states = iter(
		[
			_state(active_for_worker=[{'id': 1}]),
			_state(active_for_worker=[{'id': 1}]),
			{
				**_state(),
				'drain_ack': {'request_id': 'request-a', 'requested_at': 'now'},
			},
		]
	)
	seen_tokens = []
	monkeypatch.setattr(runtime_control, '_login', lambda: login_calls.append(True) or 'token')
	monkeypatch.setattr(runtime_control.time, 'sleep', lambda seconds: None)

	def fetch_state(worker_id, *, token, include_waiting_preview):
		seen_tokens.append(token)
		assert include_waiting_preview is False
		return next(states)

	monkeypatch.setattr(runtime_control, '_fetch_queue_state', fetch_state)
	args = argparse.Namespace(timeout_seconds=0, poll_seconds=15, allow_unacknowledged_stopped_worker=False)

	assert runtime_control.cmd_wait_for_idle(args) == 0
	assert len(login_calls) == 1
	assert seen_tokens == ['token', 'token', 'token']
