"""Read-only facts the monitor collects on the processing server itself.

`operator_status.py` covers the API, database and the hosts it reaches over
SSH. This adds what only the processing server can see: production deploy
health, kernel OOM kills in the prod processor's cgroup, the local GPU, worker
liveness from the queue, running ODM containers, the public frontend, origin/main
and recent main history from the monitor's own checkout. Nothing here
writes anywhere, and the production checkout is only read.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# The wrapper refreshes this checkout to origin/main before each tick.
MONITOR_CHECKOUT = Path(__file__).resolve().parents[2]
MAIN_HISTORY_COMMITS = 100
ODM_NAME_RE = re.compile(r'^dt-odm-.*-d(\d+)-')
PROD_CHECKOUT = Path(os.environ.get('DEADTREES_MONITOR_PROD_CHECKOUT', str(Path.home() / 'prod/deadtrees')))
PROCESSOR_CONTAINER = os.environ.get('DEADTREES_MONITOR_PROCESSOR_CONTAINER', 'deadtrees-processor-1')
FRONTEND_URLS = ('https://deadtrees.earth/', 'https://deadtrees.earth/datasets')
REPO_URL = 'https://github.com/Deadwood-ai/deadtrees.git'
# Queue worker ids of the three processors (`claimed_by`).
WORKER_NAMES = {
	'host-f9760a054cb8': 'processing-server',
	'host-bb400fd18e59': 'helicon',
	'host-56916e6e7ab8': 'deepl1',
}
LOCAL_WORKER = 'processing-server'
SILENT_HOURS = 3
# Kills since the previous tick (2 hours apart at night) plus some overlap, so
# none falls between two ticks; capped for a first run or a long outage.
OOM_OVERLAP = timedelta(minutes=5)
OOM_MAX_WINDOW = timedelta(hours=6)
# Normal while a deploy drains (docs/playbooks/operator-chat.md).
DEPLOY_NORMAL_RE = re.compile(r'already holds processor-runtime\.lock|keeping the drain', re.IGNORECASE)
DEPLOY_ERROR_RE = re.compile(r'refus|error|fatal|traceback', re.IGNORECASE)
LIVENESS_SQL = """
select q.claimed_by, q.id, q.dataset_id,
	round((extract(epoch from now() - (select max(created_at) from v2_logs l where l.dataset_id = q.dataset_id)) / 3600)::numeric, 1)
from v2_queue q where q.is_processing order by q.claimed_by, q.claimed_at
"""


def run(args: list[str], timeout: int = 30, cwd: Path | None = None) -> tuple[int, str]:
	# No bytecode files in the production checkout.
	env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}
	try:
		completed = subprocess.run(args, capture_output=True, text=True, timeout=timeout, cwd=cwd, env=env, check=False)
	except (OSError, subprocess.TimeoutExpired) as exc:
		return 127, type(exc).__name__
	return completed.returncode, (completed.stdout or completed.stderr).strip()


def origin_main() -> str | None:
	code, out = run(['git', 'ls-remote', REPO_URL, 'refs/heads/main'])
	return out.split()[0] if code == 0 and out else None


def main_history() -> list[tuple[str, datetime]] | None:
	"""Recent main commits, newest first, with the time each landed."""
	code, out = run(['git', 'log', f'-{MAIN_HISTORY_COMMITS}', '--format=%H %cI', 'HEAD'], cwd=MONITOR_CHECKOUT)
	if code != 0 or not out:
		return None
	return [(sha, datetime.fromisoformat(stamp)) for sha, stamp in (line.split() for line in out.splitlines())]


def parse_odm_datasets(names: str) -> set[int]:
	return {int(match.group(1)) for name in names.splitlines() if (match := ODM_NAME_RE.match(name))}


def running_odm_datasets() -> set[int] | None:
	"""Datasets with an ODM container running on this host."""
	code, out = run(['docker', 'ps', '--filter', 'name=dt-odm-', '--format', '{{.Names}}'])
	return parse_odm_datasets(out) if code == 0 else None


def parse_drain_age(status: dict[str, Any], now: datetime) -> float | None:
	requested = (status.get('drain_request') or {}).get('requested_at')
	if not requested:
		return None
	at = datetime.fromisoformat(str(requested).replace('Z', '+00:00'))
	return round((now - at).total_seconds() / 3600, 1)


def deploy_log_errors(lines: list[str]) -> list[str]:
	return [line[:200] for line in lines if DEPLOY_ERROR_RE.search(line) and not DEPLOY_NORMAL_RE.search(line)]


def deploy_health(now: datetime, checkout: Path = PROD_CHECKOUT) -> dict[str, Any]:
	if not checkout.is_dir():
		return {'error': 'production checkout not found'}
	log = checkout / 'auto-deploy.log'
	try:
		tail = log.read_text(errors='replace').splitlines()[-40:]
	except OSError as exc:
		return {'error': f'auto-deploy.log: {type(exc).__name__}'}
	code, dirty = run(['git', '--no-optional-locks', '-C', str(checkout), 'status', '--porcelain'])
	if code != 0:
		return {'error': 'git status failed'}
	code, out = run(['python3', 'scripts/processor_runtime_control.py', 'status'], timeout=60, cwd=checkout)
	try:
		drain_age = parse_drain_age(json.loads(out), now) if code == 0 else None
	except ValueError:
		drain_age = None
	return {
		'paused': (checkout / '.local/processor-deploy-paused').exists(),
		'dirty': ' '.join(dirty.split()[:6]),
		'log_errors': deploy_log_errors(tail),
		'drain_age_hours': drain_age,
	}


def prod_cgroup_id() -> str | None:
	code, out = run(['docker', 'inspect', PROCESSOR_CONTAINER, '--format', '{{.Id}}'])
	return out[:12] if code == 0 and out else None


def parse_oom_kills(journal: str, prod_id: str) -> list[str]:
	"""Process names the kernel OOM-killed inside the prod processor's cgroup.
	Kills in other containers (tests, profiling) are not the processor's."""
	kills = []
	cgroup = None
	for line in journal.splitlines():
		if 'oom-kill:constraint' in line:
			match = re.search(r'oom_memcg=[^,]*docker-([0-9a-f]{12})', line)
			cgroup = match.group(1) if match else None
		elif 'Killed process' in line and cgroup == prod_id:
			match = re.search(r'\(([^)]+)\)', line)
			kills.append(match.group(1) if match else '?')
	return kills


def oom_since(now: datetime, last_tick: datetime | None) -> datetime:
	start = (last_tick or now) - OOM_OVERLAP
	return max(start, now - OOM_MAX_WINDOW)


def prod_oom_kills(since: datetime) -> list[str] | None:
	prod_id = prod_cgroup_id()
	if not prod_id:
		return None
	start = since.astimezone(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
	code, out = run(['journalctl', '-k', '--since', start, '-o', 'short-iso', '--no-pager'])
	return parse_oom_kills(out, prod_id) if code == 0 else None


def gpu() -> dict[str, Any]:
	code, out = run(
		['nvidia-smi', '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader'],
		timeout=20,
	)
	if code == 127:
		return {}
	return {'ok': True, 'summary': out.splitlines()[0][:200]} if code == 0 else {'error': out.splitlines()[0][:200] if out else f'exit {code}'}


def workers() -> tuple[list[dict[str, Any]] | None, str | None]:
	url = os.environ.get('DEADTREES_ANALYST_DATABASE_URL')
	if not url:
		return None, 'DEADTREES_ANALYST_DATABASE_URL is not set'
	try:
		import psycopg  # the monitor runs from the repo venv
	except ImportError:
		return None, 'psycopg is not installed'
	try:
		with psycopg.connect(url, prepare_threshold=None, connect_timeout=10, autocommit=True) as db:
			db.execute('begin read only')
			db.execute("set local statement_timeout = '20s'")
			rows = db.execute(LIVENESS_SQL).fetchall()
	except Exception as exc:  # noqa: BLE001 - any DB failure is a coverage gap
		return None, type(exc).__name__
	# Only this host's ODM containers are visible; elsewhere it stays unknown.
	local_odm = running_odm_datasets() if any(WORKER_NAMES.get(row[0]) == LOCAL_WORKER for row in rows) else None
	return [
		{
			'name': WORKER_NAMES.get(host, host),
			'task_id': task,
			'dataset_id': dataset,
			'last_log_age_h': None if age is None else float(age),
			'silent': age is not None and float(age) > SILENT_HOURS,
			'odm_running': dataset in local_odm if local_odm is not None and WORKER_NAMES.get(host) == LOCAL_WORKER else None,
		}
		for host, task, dataset, age in rows
	], None


def http_status(url: str, timeout: int = 15) -> int | str:
	try:
		with urllib.request.urlopen(urllib.request.Request(url, method='GET'), timeout=timeout) as response:
			return response.status
	except urllib.error.HTTPError as exc:
		return exc.code
	except Exception as exc:  # noqa: BLE001 - reported as the result
		return type(exc).__name__


def collect(now: datetime | None = None, last_tick: datetime | None = None) -> dict[str, Any]:
	now = now or datetime.now(timezone.utc)
	worker_rows, worker_error = workers()
	return {
		'origin_main': origin_main(),
		'main_history': main_history(),
		'deploy': deploy_health(now),
		'prod_oom_kills': prod_oom_kills(oom_since(now, last_tick)),
		'gpu': gpu(),
		'workers': worker_rows,
		'workers_error': worker_error,
		'frontend': {url: http_status(url) for url in FRONTEND_URLS},
	}
