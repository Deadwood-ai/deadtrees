#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import socket
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
	sys.path.insert(0, str(REPO_ROOT))

from processor.src.processor import get_worker_id
from shared.db import login, use_client
from shared.settings import settings


def _drain_path() -> Path:
	return settings.processor_drain_request_path


def _utc_now() -> str:
	return datetime.now(timezone.utc).isoformat()


def _load_drain_request() -> dict | None:
	path = _drain_path()
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


def _write_drain_request(reason: str) -> dict:
	payload = {
		'reason': reason,
		'requested_at': _utc_now(),
		'requested_by': socket.gethostname(),
	}
	_drain_path().write_text(json.dumps(payload, indent=2) + '\n')
	return payload


def _clear_drain_request() -> bool:
	path = _drain_path()
	if not path.exists():
		return False
	path.unlink()
	return True


def _get_token() -> str:
	return login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)


def _fetch_queue_state(worker_id: str) -> dict:
	token = _get_token()
	with use_client(token) as client:
		active_for_worker = (
			client.table(settings.queue_table)
			.select('id,dataset_id,priority,claimed_at,task_types')
			.eq('is_processing', True)
			.eq('claimed_by', worker_id)
			.order('claimed_at')
			.execute()
			.data
			or []
		)
		active_without_owner = (
			client.table(settings.queue_table)
			.select('id,dataset_id,priority,created_at,task_types')
			.eq('is_processing', True)
			.is_('claimed_by', 'null')
			.order('created_at')
			.limit(10)
			.execute()
			.data
			or []
		)
		waiting_count = len(
			(
				client.table(settings.queue_position_table)
				.select('id')
				.limit(1000)
				.execute()
				.data
				or []
			)
		)

	return {
		'worker_id': worker_id,
		'drain_request': _load_drain_request(),
		'active_for_worker': active_for_worker,
		'active_without_owner': active_without_owner,
		'waiting_count_preview': waiting_count,
	}


def cmd_status(_: argparse.Namespace) -> int:
	print(json.dumps(_fetch_queue_state(get_worker_id()), indent=2, default=str))
	return 0


def cmd_set_drain(args: argparse.Namespace) -> int:
	payload = _write_drain_request(args.reason)
	print(json.dumps({'drain_request': payload, 'path': str(_drain_path())}, indent=2))
	return 0


def cmd_clear_drain(_: argparse.Namespace) -> int:
	cleared = _clear_drain_request()
	print(json.dumps({'cleared': cleared, 'path': str(_drain_path())}, indent=2))
	return 0


def cmd_wait_for_idle(args: argparse.Namespace) -> int:
	worker_id = get_worker_id()
	deadline = time.monotonic() + args.timeout_seconds if args.timeout_seconds > 0 else None

	while True:
		state = _fetch_queue_state(worker_id)
		if state['active_without_owner']:
			print(json.dumps({'legacy_active_rows': state['active_without_owner']}, indent=2, default=str))
			return 2

		if not state['active_for_worker']:
			print(json.dumps({'idle': True, 'worker_id': worker_id}, indent=2))
			return 0

		print(
			json.dumps(
				{
					'idle': False,
					'worker_id': worker_id,
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
		help='Wait until this worker has no active claimed task and no legacy unowned active row remains.',
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
