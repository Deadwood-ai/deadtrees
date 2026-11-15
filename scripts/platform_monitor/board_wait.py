#!/usr/bin/env python3
"""What the Platform board thread waits on, with no model running.

`board_wait.py wait` runs as a background command and exits with one JSON line
when a note waits in the outbox, or with `heartbeat` after 50 quiet minutes. A
tick cannot report its own stall, so the wait also leaves a note, once per
stalled tick, when the last tick is too old.

The heartbeat exists only because a background command can run at most two
hours. It comes before the one-hour prompt cache expires, so the thread's
quiet wake (start the next wait, nothing else) reads its context from the cache
instead of writing it again. A wake after the cache expired costs about twenty
times as much (DT-1559).
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
# Inside the one-hour prompt cache, with room for the poll and the wake itself.
HEARTBEAT = timedelta(minutes=50)
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


def pending(state_dir: Path, now: datetime, started: datetime) -> dict[str, Any]:
	note_stall(state_dir, now)
	return {
		'notes': sorted(str(path) for path in (state_dir / OUTBOX).glob('*.md')),
		'heartbeat': now - started >= HEARTBEAT,
	}


def _now() -> datetime:
	return datetime.now(timezone.utc).replace(microsecond=0)


def wait(state_dir: Path, poll: int = POLL_SECONDS) -> dict[str, Any]:
	started = _now()
	while True:
		found = pending(state_dir, _now(), started)
		if found['notes'] or found['heartbeat']:
			return found
		time.sleep(poll)


def main(argv: list[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
	parser.add_argument('action', choices=('wait',))
	parser.add_argument('--state-dir', type=Path, default=DEFAULT_STATE_DIR)
	args = parser.parse_args(argv)
	print(json.dumps(wait(args.state_dir)))
	return 0


if __name__ == '__main__':
	raise SystemExit(main())
