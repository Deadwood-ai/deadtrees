"""Fixed platform rows for the coordinator overview, from the monitor's own facts.

Every tick rebuilds the eight rows. A row takes the worst confirmed finding that
was observed this tick. A failed probe, or an earlier finding whose check did not
run, says nothing about the system, so such a row is ⚪, never 🟢, and its issue
links stay. The tick sends the board only for the reasons `wake` lists; counts
moving inside a colour stay quiet. No model decides anything here.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from fnmatch import fnmatch
from typing import Any
from zoneinfo import ZoneInfo

from findings import CONFIRM_RUNS, UNSAFE_RE

GREEN, YELLOW, RED, UNKNOWN = '🟢', '🟡', '🔴', '⚪'
SEVERITY = {'yellow': YELLOW, 'red': RED}
RANK = {'yellow': 1, 'red': 2}
LINEAR = 'https://linear.app/geosense-ufr/issue/'
BERLIN = ZoneInfo('Europe/Berlin')
MORNING_HOUR = 6
MAX_LINKS = 2
ERROR_MEMORY = timedelta(hours=24)
# Main's migrate or deploy job reports as a finding at once, not after two ticks.
CI_MARK = '/ci:'
PROCESSORS = {'processing server': 'processing', 'helicon': 'processing:helicon', 'deepl1': 'processing:deepl1'}
WORKER_NAME = {'processing server': 'processing-server'}
# Row name and the finding surfaces that colour it. App errors have no platform
# findings: their colour comes from the proven PostHog read.
ROWS: tuple[tuple[str, tuple[str, ...]], ...] = (
	('data2', ('api', 'storage')),
	('processing server', ('processing-server', 'audit-worker')),
	('helicon', ('helicon',)),
	('deepl1', ('deepl1',)),
	('backups', ('backups',)),
	('website', ('frontend',)),
	('deploys', ('deploy',)),
	('app errors', ()),
)


def _host(snapshot: dict[str, Any], key: str) -> dict[str, Any]:
	return ((snapshot.get('platform') or {}).get('hosts') or {}).get(key) or {}


def _was_read(host: dict[str, Any]) -> bool:
	# The same test as `findings.platform_findings`: a processor that answered
	# with a bad state was read, a probe that gave no output was not.
	return host.get('ok') is True or bool(host.get('processor'))


def _clean(text: object, limit: int = 60) -> str:
	return ' '.join(UNSAFE_RE.sub(' ', str(text)).split())[:limit]


def _not_read(host: dict[str, Any]) -> str:
	return 'not read: ' + _clean(host.get('error') or host.get('warning') or host.get('skipped') or 'no output')


def _disks(host: dict[str, Any]) -> str:
	return ', '.join(f'{mount} {pct}%' for mount, pct in sorted((host.get('disks') or {}).items())) or '?'


def _data2(snapshot: dict[str, Any], facts: dict[str, Any]) -> str:
	platform = snapshot.get('platform') or {}
	api, database, storage = platform.get('api') or {}, platform.get('database') or {}, _host(snapshot, 'storage')
	api_text = f"API {api.get('status')} v{api.get('version')}" if api.get('ok') else f"API {_clean(api.get('error') or api.get('skipped') or 'down', 30)}"
	database_text = 'database ok' if database.get('ok') is True else 'database not read'
	storage_text = f'disk {_disks(storage)}' if _was_read(storage) else 'storage not read'
	return f'{api_text}, {database_text}, {storage_text}'


def _processor(name: str, snapshot: dict[str, Any], facts: dict[str, Any]) -> str:
	host = _host(snapshot, PROCESSORS[name])
	if not _was_read(host):
		return _not_read(host)
	workers = facts.get('workers')
	worker = WORKER_NAME.get(name, name)
	busy = [
		f"dataset {row.get('dataset_id')}" + (f" ({_clean(row['step'], 24)})" if row.get('step') else '')
		for row in workers or [] if row.get('name') == worker
	]
	work = 'queue not read' if workers is None else ', '.join(busy) or 'idle'
	release = str((host.get('release') or {}).get('activated') or '')[:7]
	state = (host.get('processor') or {}).get('state') or 'unknown'
	return f'{state}, {work}, disk {_disks(host)}' + (f', on {release}' if release else '')


def _backups(snapshot: dict[str, Any], facts: dict[str, Any]) -> str:
	host = _host(snapshot, 'backups')
	if not _was_read(host):
		return _not_read(host)
	ages = host.get('archive_ages_hours') or {}
	return ', '.join(f"{name.removesuffix('_dump')} {round(float(age))}h" for name, age in sorted(ages.items())) + ' old' if ages else 'no archive ages'


def _website(snapshot: dict[str, Any], facts: dict[str, Any]) -> str:
	pages = facts.get('frontend') or {}
	if not pages:
		return 'not read'
	bad = [f'{url} {_clean(result, 24)}' for url, result in sorted(pages.items()) if result != 200]
	return ', '.join(bad) or 'HTTP 200'


def _deploys(snapshot: dict[str, Any], facts: dict[str, Any]) -> str:
	sha = str(facts.get('origin_main') or '?')[:7]
	jobs = facts.get('main_ci')
	if jobs is None:
		return f'main {sha}, CI not read'
	return f'main {sha}, ' + ', '.join(f"{job} {(run or {}).get('conclusion') or 'no run'}" for job, run in jobs.items())


def _unread(snapshot: dict[str, Any], facts: dict[str, Any], posthog: dict[str, Any]) -> dict[str, bool]:
	"""Whether a source of each row could not be read this tick."""
	platform = snapshot.get('platform') or {}
	workers_unread = facts.get('workers') is None
	gpu = facts.get('gpu') or {}
	deploy = facts.get('deploy') or {}
	return {
		'data2': (platform.get('api') or {}).get('ok') is None
		or (platform.get('database') or {}).get('ok') is not True
		or not _was_read(_host(snapshot, 'storage')),
		'processing server': not _was_read(_host(snapshot, 'processing')) or workers_unread
		or facts.get('prod_oom_kills') is None or not (gpu.get('ok') or gpu.get('error')),
		'helicon': not _was_read(_host(snapshot, 'processing:helicon')) or workers_unread,
		'deepl1': not _was_read(_host(snapshot, 'processing:deepl1')) or workers_unread,
		'backups': not _was_read(_host(snapshot, 'backups')),
		'website': not facts.get('frontend'),
		'deploys': not deploy or bool(deploy.get('error')) or facts.get('main_ci') is None,
		'app errors': not posthog.get('read'),
	}


def _detail(name: str, snapshot: dict[str, Any], facts: dict[str, Any], posthog: dict[str, Any]) -> str:
	if name in PROCESSORS:
		return _processor(name, snapshot, facts)
	if name == 'app errors':
		if not posthog.get('read'):
			return 'not read'
		count = len(posthog.get('recent') or {})
		return f'{count} new or spiking in 24 h' if count else 'none new in 24 h'
	return {'data2': _data2, 'backups': _backups, 'website': _website, 'deploys': _deploys}[name](snapshot, facts)


def _links(items: list[dict[str, Any]], issues: dict[str, str]) -> list[str]:
	links: list[str] = []
	for item in sorted(items, key=lambda item: -RANK.get(item.get('severity'), 0)):
		issue = issues.get(str(item.get('fingerprint')))
		if issue and issue not in links:
			links.append(issue)
	return links[:MAX_LINKS]


def build_rows(
	snapshot: dict[str, Any], facts: dict[str, Any], active: dict[str, Any], unobserved: list[str],
	issues: dict[str, str], posthog: dict[str, Any],
) -> list[dict[str, Any]]:
	"""The rows in their fixed order. `active` is the confirmed baseline."""
	unread = _unread(snapshot, facts, posthog)
	rows = []
	for name, surfaces in ROWS:
		own = [item for item in active.values() if item.get('surface') in surfaces]
		observed = [
			item for item in own
			if not str(item.get('fingerprint')).endswith('/probe')
			and not any(fnmatch(str(item.get('fingerprint')), pattern) for pattern in unobserved)
		]
		worst = max((str(item.get('severity')) for item in observed), key=lambda level: RANK.get(level, 0), default=None)
		if worst:
			state = SEVERITY.get(worst, YELLOW)
		elif name == 'app errors' and posthog.get('read') and posthog.get('recent'):
			state = YELLOW
		else:
			state = UNKNOWN if unread[name] else GREEN
		links = _links(own, issues)
		if name == 'app errors' and state == YELLOW and posthog.get('issue'):
			links = [posthog['issue']]
		try:
			detail = _detail(name, snapshot, facts, posthog)
		except (TypeError, ValueError, AttributeError):
			detail = 'unreadable'
		rows.append({
			'name': name,
			'state': state,
			'detail': detail,
			'issues': links,
			'partly_unread': unread[name],
			'reds': [item for item in observed if item.get('severity') == 'red'],
		})
	return rows


def wake(previous: dict[str, Any], rows: list[dict[str, Any]], now: datetime) -> tuple[list[str], list[dict[str, Any]], dict[str, Any]]:
	"""Why the board goes out this tick, which rows became findings, and the
	next state. `sent` is what the overview last got, so a change that was held
	back still counts as a change on the next tick."""
	first = not previous
	sent: dict[str, Any] = previous.get('sent') or {}
	unknown_ticks: dict[str, int] = dict(previous.get('unknown_ticks') or {})
	red_ticks: dict[str, int] = dict(previous.get('red_ticks') or {})
	reasons: list[str] = ['first board'] if first else []
	changed = first
	found: list[dict[str, Any]] = []
	for row in rows:
		name, state = row['name'], row['state']
		unknown_ticks[name] = unknown_ticks.get(name, 0) + 1 if state == UNKNOWN else 0
		current = {'state': state, 'issues': row['issues']}
		old = sent.get(name)
		# SSH banner timeouts flap, so one unread tick stays quiet, like every
		# other flaky surface. A later send still shows it as it is.
		settled = state != UNKNOWN or unknown_ticks[name] >= CONFIRM_RUNS
		if old and old != current and settled:
			changed = True
			reasons.append(
				f"{name} {old['state']} to {state}" if old['state'] != state else f'{name} issue link changed'
			)
		if state == RED:
			red_ticks[name] = 2 if first else min(red_ticks.get(name, 0) + 1, CONFIRM_RUNS + 1)
			# A red that is only main's CI was already reported at once.
			reds = [item for item in row['reds'] if CI_MARK not in str(item.get('fingerprint'))]
			if not first and red_ticks[name] == CONFIRM_RUNS and reds:
				reasons.append(f'{name} red on two ticks')
				found.append({'row': name, 'summary': '; '.join(str(item.get('summary')) for item in reds), 'issues': row['issues']})
		elif state != UNKNOWN and not row['partly_unread']:
			red_ticks[name] = 0
	local = now.astimezone(BERLIN)
	day = local.date().isoformat()
	morning = previous.get('morning')
	if local.hour >= MORNING_HOUR and morning != day:
		morning = day
		if not first:
			reasons.append('first tick of the day')
	return reasons, found, {
		'sent': {row['name']: {'state': row['state'], 'issues': row['issues']} for row in rows} if reasons else sent,
		'unknown_ticks': unknown_ticks,
		'red_ticks': red_ticks,
		'morning': morning,
		'changed_at': now.isoformat().replace('+00:00', 'Z') if changed else previous.get('changed_at'),
	}


def recent_errors(stored: object, error_ids: list[str], now: datetime) -> dict[str, str]:
	"""New or spiking PostHog errors of the last day, with when they were last seen so."""
	stamp = now.isoformat().replace('+00:00', 'Z')
	cutoff = (now - ERROR_MEMORY).isoformat().replace('+00:00', 'Z')
	kept = {key: at for key, at in stored.items() if isinstance(at, str) and at > cutoff} if isinstance(stored, dict) else {}
	return {**kept, **{key: stamp for key in error_ids}}


def _factory(scorecard: dict[str, Any]) -> str:
	card = scorecard.get('scorecard') or {}
	processing = card.get('processing') or {}
	if not scorecard.get('ok') or 'complete_now' not in processing:
		return 'factory not read'
	return f"factory {processing['complete_now']} complete, {processing.get('has_error_now')} errors"


def _link_text(issues: list[str]) -> str:
	return ' '.join(f'[{issue}]({LINEAR}{issue})' for issue in issues)


def render(rows: list[dict[str, Any]], changed_at: str | None, scorecard: dict[str, Any]) -> str:
	stamp = str(changed_at or '')[11:16]
	head = f"**Platform** · changed {stamp or '?'} UTC · {_factory(scorecard)}"
	lines = [head]
	for row in rows:
		links = _link_text(row['issues'])
		lines.append(f"{row['state']} {row['name']} · {row['detail']}" + (f' · {links}' if links else ''))
	return '\n'.join(lines) + '\n'


def finding_lines(found: list[dict[str, Any]], ci_items: list[dict[str, Any]], issues: dict[str, str]) -> list[str]:
	"""One `[finding]` line per row that needs a thread, or per failed CI job on main."""
	lines = [f"- [finding] {item['row']}: {_clean(item['summary'], 200)} {_link_text(item['issues'])}".rstrip() for item in found]
	for item in ci_items:
		issue = issues.get(str(item.get('fingerprint')))
		lines.append(f"- [finding] deploys: {_clean(item.get('summary'), 200)} {_link_text([issue] if issue else [])}".rstrip())
	return lines
