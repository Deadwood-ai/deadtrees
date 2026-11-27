"""The worker loop: claim a run, hand it to its check's handler, finish it, repeat.

A check plugs in with a handler module listed in HANDLERS:
	VERSION, CONFIG          the version it runs: what the models are asked; registered once, inactive
	RULES, RULES_CONFIG      how the database turns the version's answers into results;
	                         registered once with the version, inactive
	handle(ctx) -> dict      uploads the run's images and returns the p_result of
	                         audit.finish_run: inputs, evidence, tiles, images, judgements
CONFIG['models'] names the judges ({"haiku-5.5": {"transport": "claude", "model": ...}}).
The worker queues nothing itself: operators queue runs with audit.queue_runs (DT-1619).
"""

from __future__ import annotations

import faulthandler
import importlib
import json
import logging
import os
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import models, runs

log = logging.getLogger(__name__)

# check key -> handler module; each check's PR adds its line
HANDLERS: dict[str, str] = {
	'dataset_evaluation': 'processor.src.dataset_evaluation_v1.handler',
	'prediction_quality': 'processor.src.prediction_quality_v1.handler',
}
STATUS_FILE = Path(
	os.environ.get('DEADTREES_AUDIT_WORKER_STATUS', Path.home() / '.local/state/deadtrees-audit-worker/status.json')
)
MEMORY_LIMIT = 10 * 1024**3  # production ODM runs on this host too
IDLE_SECONDS = 60
LIMIT_PAUSE_SECONDS = 30 * 60
LOGIN_PROBE_SECONDS = 5 * 60
# The longest run until Nov 2026 took 75 minutes; one still going after this is stuck (DT-1619).
RUN_DEADLINE_SECONDS = 3 * 60 * 60
# While a run lasts, where every thread is goes to the log this often, so a slow run shows where.
STACK_SECONDS = 30 * 60
TIMEOUT_EXIT = 3  # the worker's exit code after a stuck run; its service starts it again


class Paused(Exception):
	def __init__(self, reason: str, transport: str, retry_seconds: int):
		super().__init__(reason)
		self.reason, self.transport, self.retry_seconds = reason, transport, retry_seconds


@dataclass
class Context:
	run: dict
	version: dict
	client: Any
	judges: dict
	put_image: Callable[[str, bytes], None]
	token: str = ''
	extra: dict = field(default_factory=dict)
	# Renews the processor login in place. The login a run starts with lasts 20 to 60 minutes;
	# a handler whose model calls can take that long calls this before its uploads.
	refresh: Callable[[], None] = lambda: None


def load_handlers(names: dict[str, str] = HANDLERS) -> tuple[dict, dict]:
	"""Importable handlers, and why the others are not."""
	handlers, missing = {}, {}
	for check, path in names.items():
		try:
			handlers[check] = importlib.import_module(path)
		except ImportError as exc:
			missing[check] = f'{type(exc).__name__}: {exc}'
	return handlers, missing


def write_status(state: str, path: Path | None = None, **fields) -> dict:
	path = path or STATUS_FILE
	status = {'state': state, 'updated_at': runs.now(), 'pid': os.getpid(), **fields}
	path.parent.mkdir(parents=True, exist_ok=True)
	with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as out:
		json.dump(status, out)
	os.replace(out.name, path)
	return status


def read_status(path: Path | None = None) -> dict | None:
	path = path or STATUS_FILE
	try:
		return json.loads(path.read_text())
	except (OSError, json.JSONDecodeError):
		return None


def memory_limit(
	cgroup_root: Path = Path('/sys/fs/cgroup'), proc_cgroup: Path = Path('/proc/self/cgroup')
) -> int | None:
	"""The tightest memory.max on this process's cgroup path, or None without one."""
	try:
		path = next(
			line.split('::', 1)[1].strip() for line in proc_cgroup.read_text().splitlines() if line.startswith('0::')
		)
	except (OSError, StopIteration):
		return None
	limits = []
	current = cgroup_root / path.lstrip('/')
	while True:
		try:
			value = (current / 'memory.max').read_text().strip()
			if value != 'max':
				limits.append(int(value))
		except OSError:
			pass
		if current == cgroup_root or current.parent == current:
			break
		current = current.parent
	return min(limits) if limits else None


@contextmanager
def deadline(run: dict, client, refresh=None, seconds: float = RUN_DEADLINE_SECONDS, stop=os._exit):
	"""Bounds one run. Every STACK_SECONDS the stacks of all threads go to stderr (the journal).
	Past `seconds` the run fails as stuck and the worker stops with TIMEOUT_EXIT: a thread stuck in
	a C call or a network read cannot be stopped from inside, so the process ends and its service
	starts it again. A stuck run fails at once, since a retry would most likely get stuck again."""

	def give_up():
		log.error('Run %s is still going after %.1f h; it fails and the worker stops', run['id'], seconds / 3600)
		faulthandler.dump_traceback(all_threads=True)
		try:
			if refresh:
				refresh(client)
			runs.fail(
				client, run, f'timed out: still running after {seconds / 3600:g} h; its stacks are in the worker log'
			)
			write_status('stopped', reason=f'run {run["id"]} timed out', run_id=run['id'])
		finally:
			stop(TIMEOUT_EXIT)

	timer = threading.Timer(seconds, give_up)
	timer.daemon = True
	faulthandler.dump_traceback_later(STACK_SECONDS, repeat=True)
	timer.start()
	try:
		yield
	finally:
		timer.cancel()
		faulthandler.cancel_dump_traceback_later()


def process(run: dict, *, client, handler, version_row: dict, put_image, token='', refresh=None) -> str:
	"""One claimed run to its end state; a pause puts it back and raises Paused.

	refresh(client) renews the client's login in place (none in tests)."""
	ctx = Context(run=run, version=version_row, client=client, judges={}, put_image=put_image, token=token)
	if refresh:
		ctx.refresh = lambda: refresh(client)
	try:
		with deadline(run, client, refresh):
			try:
				# a prepare run asks no one: the check stores its images and no answers
				if run['queue'] != 'prepare':
					ctx.judges = models.judges(version_row['config'].get('models', {}))
				result = handler.handle(ctx)
			finally:
				ctx.refresh()  # the run may have outlived its login; every outcome below is written with a valid one
			runs.finish(client, run, result)
	except models.LoginExpired as exc:
		runs.release(client, run)
		raise Paused(str(exc), exc.transport, LOGIN_PROBE_SECONDS) from exc
	except models.LimitReached as exc:
		runs.release(client, run)
		raise Paused(str(exc), exc.transport, LIMIT_PAUSE_SECONDS) from exc
	except Exception as exc:  # anything else counts as an attempt
		return runs.retry_or_fail(client, run, f'{type(exc).__name__}: {str(exc)[:500]}')
	return 'done'


def tick(*, client, handlers: dict, put_image, token='', refresh=None) -> str | None:
	"""Take and process one run; None when nothing is queued."""
	known = runs.versions(client, handlers)
	run = runs.claim_next(client, known)
	if run is None:
		return None
	version_row = known[run['version_id']]
	return process(
		run,
		client=client,
		handler=handlers[version_row['check_key']],
		version_row=version_row,
		put_image=put_image,
		token=token,
		refresh=refresh,
	)


def register(client, handlers: dict) -> dict[str, dict]:
	"""Each handler's version and its rules, inactive until an operator activates them."""
	registered = {}
	for check, h in handlers.items():
		registered[check] = runs.register_version(client, check, h.VERSION, h.CONFIG)
		runs.register_rules(client, registered[check], h.RULES, h.RULES_CONFIG)
	return registered


def run_forever(*, connect, handlers: dict, put_image, once: bool = False, sleep=time.sleep, refresh=None):
	"""connect() -> (client, token), called every tick so the processor login stays fresh;
	refresh(client) renews it in place during and after a long run."""
	client, _ = connect()
	runs.recover(client, runs.versions(client, handlers))
	while True:
		client, token = connect()
		status = read_status()
		if status and status.get('state') == 'paused':
			if not models.logged_in(status['transport']) or time.time() < status.get('retry_at', 0):
				sleep(LOGIN_PROBE_SECONDS)
				if once:
					return status
				continue
		try:
			result = tick(
				client=client,
				handlers=handlers,
				put_image=put_image,
				token=token,
				refresh=refresh,
			)
		except Paused as pause:
			status = write_status(
				'paused', reason=pause.reason, transport=pause.transport, retry_at=time.time() + pause.retry_seconds
			)
			if once:
				return status
			sleep(pause.retry_seconds)
			continue
		status = write_status('running' if result else 'idle', last_result=result, checks=sorted(handlers))
		if once:
			return status
		if result is None:
			sleep(IDLE_SECONDS)
