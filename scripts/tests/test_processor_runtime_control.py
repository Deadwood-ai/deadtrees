import argparse
import importlib.util
import io
import itertools
import json
import socket
import urllib.error
from pathlib import Path

import pytest


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


def test_ack_release_sha_must_match_when_expected():
	request = {'request_id': 'request-a', 'requested_at': 'now'}
	ack = {**_matching_ack(), 'release_sha': 'release-a'}

	assert runtime_control._ack_matches_request(request, ack, 'worker-a', 'release-a')
	assert not runtime_control._ack_matches_request(request, ack, 'worker-a', 'release-b')


def test_asset_recovery_pending_requires_asset_loss_drain(monkeypatch):
	request = {'request_id': 'request-a', 'requested_at': 'now', 'reason': 'required processor assets missing'}
	monkeypatch.setattr(runtime_control, '_load_drain_state', lambda: (request, _matching_ack()))
	assert runtime_control.cmd_asset_recovery_pending(argparse.Namespace()) == 0

	request['reason'] = 'auto-deploy release-a'
	assert runtime_control.cmd_asset_recovery_pending(argparse.Namespace()) == 1


def test_set_drain_preserves_operator_request(monkeypatch):
	existing = {'request_id': 'operator-request', 'reason': 'planned-shutdown', 'requested_at': 'now'}
	monkeypatch.setattr(runtime_control, '_load_drain_state', lambda: (existing, _matching_ack()))
	monkeypatch.setattr(
		runtime_control,
		'_write_json',
		lambda *args: (_ for _ in ()).throw(AssertionError('operator drain was replaced')),
	)

	args = argparse.Namespace(reason='required processor assets missing', preserve_operator_drain=True)

	assert runtime_control.cmd_set_drain(args) == 3


def test_worker_health_rejects_even_malformed_persisted_marker(monkeypatch, tmp_path):
	marker = tmp_path / 'loop-unhealthy.json'
	marker.write_text('interrupted write')
	monkeypatch.setattr(runtime_control, '_unhealthy_path', lambda: marker)

	assert runtime_control.cmd_worker_health(argparse.Namespace()) == 1

	marker.unlink()
	assert runtime_control.cmd_worker_health(argparse.Namespace()) == 0


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


def test_request_json_treats_dns_failure_as_transient(monkeypatch):
	def fail(request, timeout):
		raise urllib.error.URLError(socket.gaierror(-2, 'Name or service not known'))

	monkeypatch.setattr(runtime_control.urllib.request, 'urlopen', fail)

	with pytest.raises(runtime_control.TransientRequestError):
		runtime_control._request_json('GET', 'https://example.invalid/rest/v1/v2_queue', headers={})


def test_request_json_treats_server_errors_as_transient_and_client_errors_as_fatal(monkeypatch):
	def respond_with(code):
		def fail(request, timeout):
			raise urllib.error.HTTPError(request.full_url, code, 'error', {}, io.BytesIO(b'detail'))

		return fail

	monkeypatch.setattr(runtime_control.urllib.request, 'urlopen', respond_with(503))
	with pytest.raises(runtime_control.TransientRequestError):
		runtime_control._request_json('GET', 'https://example.invalid/rest/v1/v2_queue', headers={})

	monkeypatch.setattr(runtime_control.urllib.request, 'urlopen', respond_with(400))
	with pytest.raises(SystemExit):
		runtime_control._request_json('GET', 'https://example.invalid/rest/v1/v2_queue', headers={})


def test_wait_for_idle_keeps_polling_through_transient_errors(monkeypatch):
	# The 2026-09-28 yanlingfreiburg incident: DNS failed while the deploy waited for the drain,
	# the deploy paused itself, and the worker idled until a manual --resume.
	monkeypatch.setattr(runtime_control, '_worker_id', lambda: 'worker-a')
	logins = iter([runtime_control.TransientRequestError('login: dns'), 'token'])

	def login():
		result = next(logins)
		if isinstance(result, Exception):
			raise result
		return result

	outcomes = iter(
		[
			runtime_control.TransientRequestError('poll: dns'),
			_state(active_for_worker=[{'id': 1}]),
			{**_state(), 'drain_ack': _matching_ack()},
		]
	)

	def fetch_state(worker_id, *, previous_worker_id, token, include_waiting_preview):
		assert token == 'token'
		result = next(outcomes)
		if isinstance(result, Exception):
			raise result
		return result

	monkeypatch.setattr(runtime_control, '_login', login)
	monkeypatch.setattr(runtime_control, '_fetch_queue_state', fetch_state)
	monkeypatch.setattr(runtime_control.time, 'sleep', lambda seconds: None)
	args = argparse.Namespace(timeout_seconds=0, poll_seconds=15, allow_unacknowledged_stopped_worker=False)

	assert runtime_control.cmd_wait_for_idle(args) == 0


def test_wait_for_idle_times_out_instead_of_raising_on_persistent_transient_errors(monkeypatch):
	monkeypatch.setattr(runtime_control, '_worker_id', lambda: 'worker-a')
	monkeypatch.setattr(runtime_control, '_login', lambda: 'token')

	def fetch_state(worker_id, *, previous_worker_id, token, include_waiting_preview):
		raise runtime_control.TransientRequestError('poll: dns')

	ticks = itertools.count(0, 10)
	monkeypatch.setattr(runtime_control, '_fetch_queue_state', fetch_state)
	monkeypatch.setattr(runtime_control.time, 'monotonic', lambda: float(next(ticks)))
	monkeypatch.setattr(runtime_control.time, 'sleep', lambda seconds: None)
	args = argparse.Namespace(timeout_seconds=25, poll_seconds=15, allow_unacknowledged_stopped_worker=False)

	assert runtime_control.cmd_wait_for_idle(args) == 1
