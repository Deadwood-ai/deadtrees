"""The worker loop: claim a run, hand it to its check's handler, finish it, repeat.

A check plugs in with a handler module listed in HANDLERS:
	VERSION, CONFIG          the version it runs: what the models are asked; registered once, inactive
	RULES, RULES_CONFIG      how the database turns the version's answers into results;
	                         registered once with the version, inactive
	handle(ctx) -> dict      uploads the run's images and returns the p_result of
	                         audit.finish_run: inputs, evidence, tiles, images, judgements
	ready(status) -> bool    optional: whether a dataset's status row lets the check run
	inputs(client, dataset_id) -> dict
	                         optional: the evidence a run judges (ortho sha256, prediction label
	                         ids); a dataset gets a new run when the latest run of the version
	                         judged other inputs. Without it, one run per version and dataset.
CONFIG['models'] names the judges ({"haiku-5.5": {"transport": "claude", "model": ...}}).
"""

from __future__ import annotations

import importlib
import json
import logging
import os
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
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
ENQUEUE_SECONDS = 5 * 60
LIMIT_PAUSE_SECONDS = 30 * 60
LOGIN_PROBE_SECONDS = 5 * 60


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


def watermark_file() -> Path:
	return STATUS_FILE.with_name('discovered-until')


def read_watermark() -> str | None:
	"""Up to when finished datasets were queued; kept across restarts so an outage leaves no gap."""
	try:
		value = watermark_file().read_text().strip()
		datetime.fromisoformat(value)
		return value
	except (OSError, ValueError):
		return None


def write_watermark(value: str) -> None:
	path = watermark_file()
	path.parent.mkdir(parents=True, exist_ok=True)
	with tempfile.NamedTemporaryFile('w', dir=path.parent, delete=False) as out:
		out.write(value)
	os.replace(out.name, path)


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


def process(run: dict, *, client, handler, version_row: dict, put_image, token='', refresh=None) -> str:
	"""One claimed run to its end state; a pause puts it back and raises Paused.

	refresh(client) renews the client's login in place (none in tests)."""
	ctx = Context(run=run, version=version_row, client=client, judges={}, put_image=put_image, token=token)
	if refresh:
		ctx.refresh = lambda: refresh(client)
	try:
		try:
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


def judged_inputs(handler, client, dataset_ids: list[int]) -> tuple[list[int], dict | None]:
	"""What each dataset's run would judge (handler.inputs), and the datasets it could be read for.

	A dataset whose inputs cannot be read yet (a ValueError: no ortho hash, say) is left out
	and logged. One such dataset must not stop the worker or block the datasets after it.
	"""
	evidence = getattr(handler, 'inputs', None)
	if not evidence:
		return dataset_ids, None
	inputs = {}
	for dataset_id in dataset_ids:
		try:
			inputs[dataset_id] = evidence(client, dataset_id)
		except ValueError as exc:
			log.warning('Audit worker leaves dataset %s out: %s', dataset_id, exc)
	return list(inputs), inputs


def enqueue_ready(client, handlers: dict, since: str, until: str, done=lambda at: None) -> dict[str, int]:
	"""Upload-queue runs of each active version for datasets that finished processing in [since, until).

	done(updated_at) is called after each page with its last row's time, so a stop between
	pages resumes there (repeating a page only finds its runs already queued).
	"""
	active = runs.active_versions(client, handlers)
	added = dict.fromkeys(active, 0)
	for statuses in runs.processed_pages(client, since, until):
		for check, version_row in active.items():
			handler = handlers[check]
			ready = getattr(handler, 'ready', default_ready)
			ids = [s['dataset_id'] for s in statuses if ready(s)]
			ids, inputs = judged_inputs(handler, client, ids)
			added[check] += len(runs.enqueue(client, version_row, ids, 'upload', inputs=inputs))
		done(statuses[-1]['updated_at'])
	return added


def default_ready(status: dict) -> bool:
	predictions = status.get('is_combined_model_done') or (
		status.get('is_deadwood_done') and status.get('is_forest_cover_done')
	)
	return bool(status.get('is_cog_done') and predictions)


def register(client, handlers: dict) -> dict[str, dict]:
	"""Each handler's version and its rules, inactive until an operator activates them."""
	registered = {}
	for check, h in handlers.items():
		registered[check] = runs.register_version(client, check, h.VERSION, h.CONFIG)
		runs.register_rules(client, registered[check], h.RULES, h.RULES_CONFIG)
	return registered


def run_forever(*, connect, handlers: dict, put_image, once: bool = False, sleep=time.sleep, refresh=None):
	"""connect() -> (client, token), called every tick so the processor login stays fresh;
	refresh(client) renews it in place during and after a long run.

	Finished datasets are queued from the persisted watermark on, so datasets that finished
	while the worker was down are still found. The very first start looks back one hour:
	older datasets are backfill, queued explicitly.
	"""
	since = read_watermark() or (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
	next_enqueue = 0.0
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
		if time.monotonic() >= next_enqueue:
			started = runs.now()
			enqueue_ready(client, handlers, since, started, done=write_watermark)
			write_watermark(started)
			since, next_enqueue = started, time.monotonic() + ENQUEUE_SECONDS
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
