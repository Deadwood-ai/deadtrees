import argparse
import importlib.util
import json
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / 'processor_runtime_control.py'
SPEC = importlib.util.spec_from_file_location('processor_runtime_control', SCRIPT)
assert SPEC is not None and SPEC.loader is not None
runtime_control = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime_control)


def _state(*, active_for_worker=None, active_for_previous_worker=None, active_without_owner=None):
	return {
		'worker_id': 'worker-a',
		'drain_request': {'request_id': 'request-a', 'requested_at': 'now'},
		'drain_ack': None,
		'active_for_worker': active_for_worker or [],
		'active_for_previous_worker': active_for_previous_worker or [],
		'active_without_owner': active_without_owner or [],
	}


def _matching_ack():
	return {'request_id': 'request-a', 'requested_at': 'now', 'acknowledged_by': 'worker-a'}


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


def test_wait_for_idle_rejects_stopped_recovery_with_previous_worker_active_row(monkeypatch):
	monkeypatch.setattr(runtime_control, '_activated_worker_id', lambda: 'worker-old')
	monkeypatch.setattr(runtime_control, '_login', lambda: 'token')

	def fetch_state(worker_id, **kwargs):
		assert kwargs['previous_worker_id'] == 'worker-old'
		return _state(active_for_previous_worker=[{'id': 124, 'claimed_by': 'worker-old'}])

	monkeypatch.setattr(
		runtime_control,
		'_fetch_queue_state',
		fetch_state,
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


def test_record_worker_id_persists_identity_for_next_recovery(monkeypatch, tmp_path):
	path = tmp_path / 'processor-activated-worker-id'
	monkeypatch.setattr(runtime_control, '_worker_id', lambda: 'worker-current')
	monkeypatch.setattr(runtime_control, '_activated_worker_id_path', lambda: path)

	assert runtime_control.cmd_record_worker_id(argparse.Namespace()) == 0
	assert runtime_control._activated_worker_id() == 'worker-current'


def test_wait_for_idle_reuses_login_and_skips_waiting_preview(monkeypatch):
	login_calls = []
	preview_calls = []
	monkeypatch.setattr(runtime_control, '_worker_id', lambda: 'worker-a')
	monkeypatch.setattr(runtime_control, '_login', lambda: login_calls.append(True) or 'token')
	monkeypatch.setattr(
		runtime_control,
		'_load_drain_state',
		lambda: (
			{'request_id': 'request-a', 'requested_at': 'now'},
			_matching_ack(),
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
	monkeypatch.setattr(runtime_control, '_worker_id', lambda: 'worker-a')
	monkeypatch.setattr(runtime_control, '_login', lambda: login_calls.append(True) or next(tokens))

	def fetch_state(worker_id, *, previous_worker_id, token, include_waiting_preview):
		seen_tokens.append(token)
		assert previous_worker_id is None
		assert include_waiting_preview is False
		if token == 'expired-token':
			raise runtime_control.AuthenticationExpiredError('expired')
		return {
			**_state(),
			'drain_ack': _matching_ack(),
		}

	monkeypatch.setattr(runtime_control, '_fetch_queue_state', fetch_state)
	args = argparse.Namespace(timeout_seconds=1, poll_seconds=0, allow_unacknowledged_stopped_worker=False)

	assert runtime_control.cmd_wait_for_idle(args) == 0
	assert len(login_calls) == 2
	assert seen_tokens == ['expired-token', 'fresh-token']


def test_wait_for_idle_reuses_login_across_multiple_polls(monkeypatch):
	login_calls = []
	monkeypatch.setattr(runtime_control, '_worker_id', lambda: 'worker-a')
	states = iter(
		[
			_state(active_for_worker=[{'id': 1}]),
			_state(active_for_worker=[{'id': 1}]),
			{
				**_state(),
				'drain_ack': _matching_ack(),
			},
		]
	)
	seen_tokens = []
	monkeypatch.setattr(runtime_control, '_login', lambda: login_calls.append(True) or 'token')
	monkeypatch.setattr(runtime_control.time, 'sleep', lambda seconds: None)

	def fetch_state(worker_id, *, previous_worker_id, token, include_waiting_preview):
		seen_tokens.append(token)
		assert previous_worker_id is None
		assert include_waiting_preview is False
		return next(states)

	monkeypatch.setattr(runtime_control, '_fetch_queue_state', fetch_state)
	args = argparse.Namespace(timeout_seconds=0, poll_seconds=15, allow_unacknowledged_stopped_worker=False)

	assert runtime_control.cmd_wait_for_idle(args) == 0
	assert len(login_calls) == 1
	assert seen_tokens == ['token', 'token', 'token']


def test_control_paths_default_to_gitignored_repo_directory(monkeypatch):
	monkeypatch.setattr(runtime_control, 'ENV', {})

	assert runtime_control._drain_request_path() == runtime_control.REPO_ROOT / '.local/processor-control/drain-request.json'
	assert runtime_control._drain_ack_path() == runtime_control.REPO_ROOT / '.local/processor-control/drain-ack.json'


def test_control_paths_support_absolute_host_override(monkeypatch, tmp_path):
	monkeypatch.setattr(runtime_control, 'ENV', {'PROCESSOR_CONTROL_DIR': str(tmp_path)})

	assert runtime_control._drain_request_path() == tmp_path / 'drain-request.json'
	assert runtime_control._drain_ack_path() == tmp_path / 'drain-ack.json'


def test_write_json_atomically_replaces_read_only_file(tmp_path):
	path = tmp_path / 'drain-request.json'
	path.write_text('{"stale": true}\n')
	path.chmod(0o444)

	runtime_control._write_json(path, {'request_id': 'new-request'})

	assert json.loads(path.read_text()) == {'request_id': 'new-request'}
	assert list(tmp_path.glob('.*.tmp')) == []


def test_wait_for_idle_rejects_acknowledgement_from_previous_worker_id(monkeypatch):
	monkeypatch.setattr(runtime_control, '_login', lambda: 'token')
	monkeypatch.setattr(
		runtime_control,
		'_fetch_queue_state',
		lambda worker_id, **kwargs: {
			**_state(),
			'drain_ack': {'request_id': 'request-a', 'requested_at': 'now', 'acknowledged_by': 'worker-old'},
		},
	)
	monotonic_values = iter([0.0, 2.0])
	monkeypatch.setattr(runtime_control.time, 'monotonic', lambda: next(monotonic_values))
	monkeypatch.setattr(runtime_control.time, 'sleep', lambda seconds: None)
	args = argparse.Namespace(timeout_seconds=1, poll_seconds=0, allow_unacknowledged_stopped_worker=False)

	assert runtime_control.cmd_wait_for_idle(args) == 1
