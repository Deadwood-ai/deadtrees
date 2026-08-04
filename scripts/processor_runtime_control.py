#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

QUEUE_TABLE = 'v2_queue'
QUEUE_POSITION_TABLE = 'v2_queue_positions'
DEFAULT_DRAIN_REQUEST_PATH = '/data/processor-control/drain-request.json'
DEFAULT_DRAIN_ACK_PATH = '/data/processor-control/drain-ack.json'
DEFAULT_PROCESSOR_USERNAME = 'processor@deadtrees.earth'


def _load_env_file(path: Path) -> dict[str, str]:
	env: dict[str, str] = {}
	if not path.exists():
		return env

	for raw_line in path.read_text().splitlines():
		line = raw_line.strip()
		if not line or line.startswith('#') or '=' not in line:
			continue
		key, value = line.split('=', 1)
		value = value.strip()
		if value and value[0] == value[-1] and value[0] in {'"', "'"}:
			value = value[1:-1]
		env[key.strip()] = os.path.expandvars(value)
	return env


REPO_ROOT = Path(__file__).resolve().parents[1]
ENV = {
	**_load_env_file(REPO_ROOT / '.env'),
	**os.environ,
}


def _require_env(name: str, default: str | None = None) -> str:
	value = ENV.get(name, default)
	if value is None or value == '':
		raise SystemExit(f'Missing required environment variable: {name}')
	return value


def _supabase_url() -> str:
	return _require_env('SUPABASE_URL').rstrip('/')


def _supabase_key() -> str:
	return _require_env('SUPABASE_KEY')


def _processor_username() -> str:
	return ENV.get('PROCESSOR_USERNAME', DEFAULT_PROCESSOR_USERNAME)


def _processor_password() -> str:
	return _require_env('PROCESSOR_PASSWORD')


def _drain_request_path() -> Path:
	return Path(ENV.get('PROCESSOR_DRAIN_REQUEST_PATH', DEFAULT_DRAIN_REQUEST_PATH))


def _drain_ack_path() -> Path:
	return Path(ENV.get('PROCESSOR_DRAIN_ACK_PATH', DEFAULT_DRAIN_ACK_PATH))


def _worker_id() -> str:
	worker_id = ENV.get('PROCESSOR_WORKER_ID', '').strip()
	if worker_id:
		return worker_id
	for machine_id_path in (Path('/etc/machine-id'),):
		try:
			machine_id = machine_id_path.read_text().strip()
		except OSError:
			continue
		if machine_id:
			return f'host-{machine_id[:12]}'
	return f'host-{socket.gethostname()}'


def _utc_now() -> str:
	return datetime.now(timezone.utc).isoformat()


def _read_json(path: Path) -> dict | None:
	if not path.exists():
		return None
	try:
		return json.loads(path.read_text())
	except json.JSONDecodeError:
		return {
			'path': str(path),
			'invalid_json': True,
			'raw': path.read_text(),
		}


def _write_json(path: Path, payload: dict) -> None:
	path.parent.mkdir(parents=True, exist_ok=True)
	path.write_text(json.dumps(payload, indent=2) + '\n')


def _clear_file(path: Path) -> bool:
	if not path.exists():
		return False
	path.unlink()
	return True


def _api_headers(token: str | None = None, *, prefer_representation: bool = False) -> dict[str, str]:
	headers = {
		'apikey': _supabase_key(),
		'Content-Type': 'application/json',
	}
	if token is not None:
		headers['Authorization'] = f'Bearer {token}'
	if prefer_representation:
		headers['Prefer'] = 'return=representation'
	return headers


def _request_json(
	method: str,
	url: str,
	*,
	headers: dict[str, str],
	payload: dict | None = None,
) -> dict | list:
	data = None if payload is None else json.dumps(payload).encode('utf-8')
	request = urllib.request.Request(url, data=data, headers=headers, method=method)
	try:
		with urllib.request.urlopen(request, timeout=30) as response:
			body = response.read().decode('utf-8')
	except urllib.error.HTTPError as exc:
		detail = exc.read().decode('utf-8', errors='replace')
		raise SystemExit(f'{method} {url} failed: {exc.code} {detail}') from exc

	return json.loads(body) if body else {}


def _login() -> str:
	url = f"{_supabase_url()}/auth/v1/token?grant_type=password"
	response = _request_json(
		'POST',
		url,
		headers=_api_headers(),
		payload={'email': _processor_username(), 'password': _processor_password()},
	)
	access_token = response.get('access_token')
	if not access_token:
		raise SystemExit('Supabase auth response did not include access_token')
	return access_token


def _rest_url(table: str, **params: str) -> str:
	query = urllib.parse.urlencode(params, doseq=True)
	return f"{_supabase_url()}/rest/v1/{table}?{query}"


def _load_drain_state() -> tuple[dict | None, dict | None]:
	return _read_json(_drain_request_path()), _read_json(_drain_ack_path())


def _ack_matches_request(request: dict | None, ack: dict | None) -> bool:
	if request is None or ack is None:
		return False
	return ack.get('request_id') == request.get('request_id') and ack.get('requested_at') == request.get('requested_at')


def _fetch_queue_rows(token: str, *, claimed_by: str | None = None, null_claimed_by: bool = False) -> list[dict]:
	params = {
		'select': 'id,dataset_id,priority,claimed_at,created_at,task_types,claimed_by',
		'is_processing': 'eq.true',
		'order': 'claimed_at.asc,created_at.asc',
	}
	if claimed_by is not None:
		params['claimed_by'] = f'eq.{claimed_by}'
	if null_claimed_by:
		params['claimed_by'] = 'is.null'
	return _request_json('GET', _rest_url(QUEUE_TABLE, **params), headers=_api_headers(token))


def _fetch_waiting_count_preview(token: str) -> int:
	rows = _request_json(
		'GET',
		_rest_url(QUEUE_POSITION_TABLE, select='id', limit='1000'),
		headers=_api_headers(token),
	)
	return len(rows)


def _fetch_queue_state(worker_id: str) -> dict:
	token = _login()
	request, ack = _load_drain_state()
	return {
		'worker_id': worker_id,
		'drain_request': request,
		'drain_ack': ack,
		'ack_matches_request': _ack_matches_request(request, ack),
		'active_for_worker': _fetch_queue_rows(token, claimed_by=worker_id),
		'active_without_owner': _fetch_queue_rows(token, null_claimed_by=True),
		'waiting_count_preview': _fetch_waiting_count_preview(token),
	}


def cmd_status(_: argparse.Namespace) -> int:
	print(json.dumps(_fetch_queue_state(_worker_id()), indent=2, default=str))
	return 0


def cmd_set_drain(args: argparse.Namespace) -> int:
	_clear_file(_drain_ack_path())
	payload = {
		'request_id': str(uuid.uuid4()),
		'reason': args.reason,
		'requested_at': _utc_now(),
		'requested_by': socket.gethostname(),
	}
	_write_json(_drain_request_path(), payload)
	print(json.dumps({'drain_request': payload, 'path': str(_drain_request_path())}, indent=2))
	return 0


def cmd_clear_drain(_: argparse.Namespace) -> int:
	cleared_request = _clear_file(_drain_request_path())
	cleared_ack = _clear_file(_drain_ack_path())
	print(
		json.dumps(
			{
				'cleared_request': cleared_request,
				'cleared_ack': cleared_ack,
				'request_path': str(_drain_request_path()),
				'ack_path': str(_drain_ack_path()),
			},
			indent=2,
		)
	)
	return 0


def cmd_wait_for_idle(args: argparse.Namespace) -> int:
	worker_id = _worker_id()
	deadline = time.monotonic() + args.timeout_seconds if args.timeout_seconds > 0 else None

	while True:
		state = _fetch_queue_state(worker_id)
		request = state['drain_request']
		ack = state['drain_ack']

		if request is None:
			print(json.dumps({'idle': False, 'error': 'drain_request_missing'}, indent=2))
			return 2

		if state['active_without_owner']:
			print(json.dumps({'legacy_active_rows': state['active_without_owner']}, indent=2, default=str))
			return 2

		if _ack_matches_request(request, ack) and not state['active_for_worker']:
			print(
				json.dumps(
					{
						'idle': True,
						'worker_id': worker_id,
						'drain_request': request,
						'drain_ack': ack,
					},
					indent=2,
					default=str,
				)
			)
			return 0

		print(
			json.dumps(
				{
					'idle': False,
					'worker_id': worker_id,
					'drain_request': request,
					'drain_ack': ack,
					'ack_matches_request': _ack_matches_request(request, ack),
					'active_for_worker': state['active_for_worker'],
				},
				indent=2,
				default=str,
			)
		)

		if deadline is not None and time.monotonic() >= deadline:
			return 1

		time.sleep(args.poll_seconds)


def build_parser() -> argparse.ArgumentParser:
	parser = argparse.ArgumentParser(
		description='Manage drain state and queue visibility for the DeadTrees processor host.'
	)
	subparsers = parser.add_subparsers(dest='command', required=True)

	status = subparsers.add_parser('status', help='Print the current worker drain and queue state.')
	status.set_defaults(func=cmd_status)

	set_drain = subparsers.add_parser('set-drain', help='Request a drain so this worker stops claiming new tasks.')
	set_drain.add_argument('--reason', required=True, help='Short operator reason for the drain request.')
	set_drain.set_defaults(func=cmd_set_drain)

	clear_drain = subparsers.add_parser('clear-drain', help='Clear the drain request so the worker can resume.')
	clear_drain.set_defaults(func=cmd_clear_drain)

	wait_for_idle = subparsers.add_parser(
		'wait-for-idle',
		help='Wait until this worker has acknowledged the current drain request and holds no active task.',
	)
	wait_for_idle.add_argument('--timeout-seconds', type=int, default=0, help='0 waits forever.')
	wait_for_idle.add_argument('--poll-seconds', type=int, default=15)
	wait_for_idle.set_defaults(func=cmd_wait_for_idle)

	return parser


def main() -> int:
	parser = build_parser()
	args = parser.parse_args()
	return args.func(args)


if __name__ == '__main__':
	raise SystemExit(main())
