#!/usr/bin/env python3
"""What the Platform board thread waits on, with no model running.

`board_wait.py wait` runs as a background command and exits with one JSON line
when a note waits in the outbox or the two-hour reconcile is due. A tick cannot
report its own stall, so the wait also leaves a note, once per stalled tick,
when the last tick is too old. After reconciling thread states the thread runs
`board_wait.py reconciled`.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from monitor_tick import DEFAULT_STATE_DIR, OUTBOX, TICK_STATE, iso, load_json, post_outbox, write_atomic

WAIT_STATE = 'board-wait.json'
BERLIN = ZoneInfo('Europe/Berlin')
WORK_START, WORK_END = 6, 18
# Just under the two-hour limit of a background command, so the wait ends first.
RECONCILE_EVERY = timedelta(minutes=115)
POLL_SECONDS = 60


def _time(value: Any) -> datetime | None:
	try:
		return datetime.fromisoformat(str(value).replace('Z', '+00:00'))
	except ValueError:
		return None


def stall_limit(now: datetime) -> timedelta:
	"""Two slots plus a slow tick. The first hour of the day still follows the
	two-hour night slots."""
	hour = now.astimezone(BERLIN).hour
	return timedelta(minutes=45) if WORK_START < hour < WORK_END else timedelta(minutes=150)


def note_stall(state_dir: Path, now: datetime) -> None:
	last_tick = load_json(state_dir / TICK_STATE).get('last_tick_at')
	last = _time(last_tick)
	if last and now - last <= stall_limit(now):
		return
	wait_file = state_dir / WAIT_STATE
	seen = load_json(wait_file)
	if seen.get('stalled_tick', '') == last_tick:
		return
	age = f'{int((now - last).total_seconds() // 60)} min ago' if last else 'never recorded'
	# The note comes first: a crash between the two repeats the note, it never loses it.
	post_outbox(state_dir, now, f'DeadTrees monitor stalled at {iso(now)}: last tick {last_tick} ({age}). The board is stale.\n')
	write_atomic(wait_file, json.dumps({**seen, 'stalled_tick': last_tick}) + '\n')


def pending(state_dir: Path, now: datetime) -> dict[str, Any]:
	note_stall(state_dir, now)
	reconciled = _time(load_json(state_dir / WAIT_STATE).get('reconciled_at'))
	return {
		'notes': sorted(str(path) for path in (state_dir / OUTBOX).glob('*.md')),
		'reconcile_due': reconciled is None or now - reconciled >= RECONCILE_EVERY,
	}


def wait(state_dir: Path, poll: int = POLL_SECONDS) -> dict[str, Any]:
	while True:
		found = pending(state_dir, datetime.now(timezone.utc).replace(microsecond=0))
		if found['notes'] or found['reconcile_due']:
			return found
		time.sleep(poll)


def reconciled(state_dir: Path, now: datetime) -> None:
	wait_file = state_dir / WAIT_STATE
	write_atomic(wait_file, json.dumps({**load_json(wait_file), 'reconciled_at': iso(now)}) + '\n')


def main(argv: list[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
	parser.add_argument('action', choices=('wait', 'reconciled'))
	parser.add_argument('--state-dir', type=Path, default=DEFAULT_STATE_DIR)
	args = parser.parse_args(argv)
	if args.action == 'reconciled':
		reconciled(args.state_dir, datetime.now(timezone.utc).replace(microsecond=0))
		return 0
	print(json.dumps(wait(args.state_dir)))
	return 0


if __name__ == '__main__':
	raise SystemExit(main())
