"""Fingerprinted platform findings for the DeadTrees monitor.

The finding rules live here, not in a model prompt: the monitor's model calls
only file what this module reports. Input is the `operator_status.py` JSON
snapshot plus the processing-server facts from `host_facts.py`.

A finding is a dict with `severity` (`red` or `yellow`), `surface`,
`fingerprint` (`dt-status/<surface>/<key>`) and `summary`. A coverage gap is a
plain string: a check that could not run, reported in the digest, never green.
Each builder also returns the fingerprint patterns it could not observe this
run, so a finding filed earlier is kept, not cleared, while its check is down.
"""

from __future__ import annotations

import re
from datetime import datetime
from fnmatch import fnmatch
from typing import Any

DISK_WATCH_PCT = 85
# The nightly DB backup's pg_dump keeps about 210 GB on the storage host's `/`
# between 23:30Z and 06:00Z, so `/` only counts above 90% then.
STORAGE_NIGHT_DISK_PCT = 90
# janusch's rule (2026-10-02): helicon `/` above 97% is urgent.
HELICON_URGENT_DISK_PCT = 97
BACKUP_MAX_AGE_HOURS = 36
DRAIN_MAX_AGE_HOURS = 12
# Flaky surfaces (SSH banner timeouts, one slow page) count only after this
# many runs in a row, and clear only after as many quiet runs.
CONFIRM_RUNS = 2
# Findings that come from a host's own status probe; unobserved while it fails.
HOST_KEYS = ('disk:*', 'processor', 'restarts', 'oom-killed', 'api-*', 'cron:*', 'age:*')


# Summaries reach a model with Linear write tools, and parts of them (log
# lines, probe errors, file names) are not ours, so only plain characters pass.
UNSAFE_RE = re.compile(r"[^\w\s.,:;/@%()=+'`<>?-]")


def finding(severity: str, surface: str, key: str, summary: str, *, confirm: bool = False) -> dict[str, Any]:
	item = {
		'severity': severity,
		'surface': surface,
		'fingerprint': f'dt-status/{surface}/{key}',
		'summary': ' '.join(UNSAFE_RE.sub(' ', summary).split())[:240],
	}
	if confirm:
		item['confirm'] = True
	return item


def host_label(key: str) -> str:
	return 'processing-server' if key == 'processing' else key.removeprefix('processing:')


def storage_night(now: datetime) -> bool:
	minutes = now.hour * 60 + now.minute
	return minutes >= 23 * 60 + 30 or minutes < 6 * 60


def disk_findings(label: str, disks: dict[str, Any], now: datetime) -> list[dict[str, Any]]:
	found = []
	for mount, pct in sorted(disks.items()):
		pct = int(pct)
		if label == 'helicon' and mount == '/' and pct > HELICON_URGENT_DISK_PCT:
			found.append(finding('red', label, f'disk:{mount}', f'helicon `/` is {pct}% full (urgent above {HELICON_URGENT_DISK_PCT}%: stop the processor and requeue its task)'))
		elif label == 'storage' and mount == '/' and storage_night(now):
			if pct > STORAGE_NIGHT_DISK_PCT:
				found.append(finding('yellow', label, f'disk:{mount}', f'storage `/` is {pct}% full during the backup window'))
		elif pct >= DISK_WATCH_PCT:
			found.append(finding('yellow', label, f'disk:{mount}', f'{label} `{mount}` is {pct}% full'))
	return found


def processor_findings(label: str, host: dict[str, Any]) -> list[dict[str, Any]]:
	processor = host.get('processor') or {}
	if not processor:
		return []
	found = []
	state = processor.get('state')
	if state != 'running':
		found.append(finding('red', label, 'processor', f'{label} processor container is {state or "unknown"} (exit {processor.get("exit")})'))
	restarts = int(processor.get('restarts') or 0)
	if restarts > 0:
		found.append(finding('yellow', label, 'restarts', f'{label} processor restarted {restarts} time(s)'))
	if processor.get('oom') is True:
		found.append(finding('yellow', label, 'oom-killed', f'{label} processor container was OOM-killed'))
	return found


def storage_findings(host: dict[str, Any], origin_main: str | None) -> list[dict[str, Any]]:
	found = []
	for line in host.get('lines') or []:
		key, _, value = line.partition('=')
		if key == 'api_checkout' and origin_main and value and not origin_main.startswith(value[:7]):
			found.append(finding('yellow', 'storage', 'api-checkout', f'storage API checkout {value[:7]} differs from origin/main {origin_main[:7]}', confirm=True))
		elif key == 'api':
			fields = dict(part.partition('=')[::2] for part in value.split())
			if fields.get('state') != 'running':
				found.append(finding('red', 'storage', 'api-container', f'API container is {fields.get("state") or "unknown"}'))
			elif int(fields.get('restarts') or 0) > 0:
				found.append(finding('yellow', 'storage', 'api-restarts', f'API container restarted {fields["restarts"]} time(s)'))
		elif key == 'cron' and value.endswith(' missing'):
			name = value.removesuffix(' missing')
			found.append(finding('yellow', 'storage', f'cron:{name}', f'storage cron `{name}` is missing'))
	return found


def backup_findings(host: dict[str, Any]) -> list[dict[str, Any]]:
	found = []
	for name, age in sorted((host.get('archive_ages_hours') or {}).items()):
		if float(age) > BACKUP_MAX_AGE_HOURS:
			found.append(finding('yellow', 'backups', f'age:{name}', f'{name} backup archive is {float(age):.0f} h old'))
	return found


def host_patterns(label: str) -> list[str]:
	return [f'dt-status/{label}/{key}' for key in HOST_KEYS]


def platform_findings(
	snapshot: dict[str, Any], now: datetime, origin_main: str | None
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
	found: list[dict[str, Any]] = []
	gaps: list[str] = []
	unobserved: list[str] = [] if origin_main else ['dt-status/storage/api-checkout']
	platform = snapshot.get('platform') or {}

	api = platform.get('api') or {}
	if api.get('ok') is False:
		found.append(finding('red', 'api', 'smoke', f'API smoke failed: {api.get("error") or api.get("status")}', confirm=True))
	elif api.get('ok') is None:
		gaps.append('api: not checked')
		unobserved.append('dt-status/api/*')

	database = platform.get('database') or {}
	if database.get('ok') is not True:
		gaps.append(f'database summary: {database.get("error") or "not configured"}')

	for key, host in sorted((platform.get('hosts') or {}).items()):
		label = 'storage' if key == 'storage' else 'backups' if key == 'backups' else host_label(key)
		if host.get('ok') is None:
			if host.get('warning') or host.get('skipped'):
				gaps.append(f'{label}: {host.get("warning") or host.get("skipped")}')
			unobserved += host_patterns(label)
			continue
		if host.get('ok') is False and not host.get('processor'):
			found.append(finding('yellow', label, 'probe', f'{label} status probe failed: {host.get("error") or "no output"}', confirm=True))
			unobserved += host_patterns(label)
			continue
		found += disk_findings(label, host.get('disks') or {}, now)
		if key.startswith('processing'):
			found += processor_findings(label, host)
		elif key == 'storage':
			found += storage_findings(host, origin_main)
		elif key == 'backups':
			found += backup_findings(host)
	return found, gaps, unobserved


def deploy_findings(deploy: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str], list[str]]:
	if not deploy or deploy.get('error'):
		return [], [f'deploy health: {deploy.get("error") if deploy else "not checked"}'], ['dt-status/deploy/*']
	found = []
	if deploy.get('paused'):
		found.append(finding('yellow', 'deploy', 'paused', 'processor deploy pause marker is present'))
	if deploy.get('dirty'):
		found.append(finding('yellow', 'deploy', 'dirty-checkout', f'production checkout is dirty, so auto-deploy refuses: {deploy["dirty"]}'))
	if deploy.get('log_errors'):
		found.append(finding('yellow', 'deploy', 'log-error', f'auto-deploy log: {deploy["log_errors"][-1]}'))
	age = deploy.get('drain_age_hours')
	if age is not None and float(age) > DRAIN_MAX_AGE_HOURS:
		found.append(finding('yellow', 'deploy', 'drain-age', f'processor drain has been held for {float(age):.1f} h'))
	return found, [], []


def local_findings(facts: dict[str, Any]) -> tuple[list[dict[str, Any]], list[str], list[str]]:
	found: list[dict[str, Any]] = []
	gaps: list[str] = []
	unobserved: list[str] = []
	kills = facts.get('prod_oom_kills')
	if kills is None:
		gaps.append('processing-server OOM kills: not checked')
		unobserved.append('dt-status/processing-server/oom')
	elif kills:
		found.append(finding('yellow', 'processing-server', 'oom', f'kernel OOM-killed {", ".join(kills)} in the prod processor cgroup'))

	gpu = facts.get('gpu') or {}
	if gpu.get('error'):
		found.append(finding('red', 'processing-server', 'gpu', f'GPU check failed: {gpu["error"]}'))
	elif not gpu.get('ok'):
		gaps.append('processing-server GPU: not checked')
		unobserved.append('dt-status/processing-server/gpu')

	workers = facts.get('workers')
	if workers is None:
		gaps.append(f'worker liveness: {facts.get("workers_error") or "not checked"}')
		unobserved.append('dt-status/*/worker-silent')
	for worker in workers or []:
		if worker.get('silent'):
			found.append(finding(
				'red', worker['name'], 'worker-silent',
				f'{worker["name"]} worker silent {worker["last_log_age_h"]} h on dataset {worker["dataset_id"]} (task {worker["task_id"]})',
			))

	if not facts.get('frontend'):
		unobserved.append('dt-status/frontend/*')
	for url, result in sorted((facts.get('frontend') or {}).items()):
		if result != 200:
			found.append(finding('yellow', 'frontend', f'http:{url}', f'{url} returned {result}', confirm=True))
	return found, gaps, unobserved


def build_findings(
	snapshot: dict[str, Any], facts: dict[str, Any], now: datetime
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
	"""Findings, coverage gaps and the fingerprint patterns not observed."""
	found, gaps, unobserved = platform_findings(snapshot, now, facts.get('origin_main'))
	deploy, deploy_gaps, deploy_unobserved = deploy_findings(facts.get('deploy') or {})
	local, local_gaps, local_unobserved = local_findings(facts)
	unique = {item['fingerprint']: item for item in found + deploy + local}
	ordered = sorted(unique.values(), key=lambda item: (item['severity'] != 'red', item['fingerprint']))
	return ordered, gaps + deploy_gaps + local_gaps, unobserved + deploy_unobserved + local_unobserved


def verdict(findings: list[dict[str, Any]]) -> str:
	if any(item['severity'] == 'red' for item in findings):
		return 'red'
	return 'yellow' if findings else 'green'


def diff_findings(
	baseline: dict[str, Any], current: list[dict[str, Any]], unobserved: list[str] = ()
) -> tuple[dict[str, Any], dict[str, Any]]:
	"""Compare this run with the filed baseline.

	Returns the delta (`new`, `changed`, `cleared`) and the next baseline. A
	finding marked `confirm` becomes new only on its second run in a row and
	clears only after as many quiet runs; others act at once. An active finding
	whose check did not run (`unobserved`) is kept as it is."""
	active: dict[str, Any] = dict(baseline.get('active') or {})
	pending: dict[str, int] = dict(baseline.get('pending') or {})
	quiet: dict[str, int] = dict(baseline.get('quiet') or {})
	delta: dict[str, list[Any]] = {'new': [], 'changed': [], 'cleared': []}
	seen = set()
	next_pending: dict[str, int] = {}
	for item in current:
		key = item['fingerprint']
		seen.add(key)
		if key in active:
			old = active[key]
			if old['severity'] != item['severity']:
				delta['changed'].append({**item, 'previous_severity': old['severity']})
			active[key] = item
			continue
		runs = pending.get(key, 0) + 1
		if item.get('confirm') and runs < CONFIRM_RUNS:
			next_pending[key] = runs
			continue
		delta['new'].append(item)
		active[key] = item
	next_quiet: dict[str, int] = {}
	for key, old in list(active.items()):
		if key in seen:
			continue
		if any(fnmatch(key, pattern) for pattern in unobserved):
			if key in quiet:
				next_quiet[key] = quiet[key]
			continue
		runs = quiet.get(key, 0) + 1
		if old.get('confirm') and runs < CONFIRM_RUNS:
			next_quiet[key] = runs
			continue
		delta['cleared'].append(old)
		del active[key]
	return (
		{key: items for key, items in delta.items() if items},
		{'active': active, 'pending': next_pending, 'quiet': next_quiet},
	)
