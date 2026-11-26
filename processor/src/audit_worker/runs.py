"""The worker's reads and writes on audit.runs (Supabase, as the processor).

New uploads go first, then manual runs, then the backfill. A run is claimed by moving it from
queued to running, so a second worker could never take the same run. A finished run is stored
by audit.finish_run in one transaction; which run counts for a dataset is the database's view
audit.current_runs, so the worker points nothing.
"""

from __future__ import annotations

from datetime import datetime, timezone

QUEUE_ORDER = ('upload', 'manual', 'backfill')
MAX_ATTEMPTS = 3


def now() -> str:
	return datetime.now(timezone.utc).isoformat()


def audit(client):
	return client.schema('audit')


def versions(client, checks) -> dict[int, dict]:
	"""Every version of these checks, by id."""
	rows = audit(client).table('check_versions').select('*').in_('check_key', list(checks)).execute().data
	return {row['id']: row for row in rows}


def active_versions(client, checks) -> dict[str, dict]:
	return {row['check_key']: row for row in versions(client, checks).values() if row['is_active']}


def register_version(client, check_key: str, name: str, config: dict) -> dict:
	"""The handler's version, inserted once and inactive; an operator activates it."""
	table = audit(client).table('check_versions')
	found = table.select('*').eq('check_key', check_key).eq('version', name).execute().data
	if found:
		return found[0]
	return table.insert({'check_key': check_key, 'version': name, 'config': config}).execute().data[0]


def register_rules(client, version_row: dict, name: str, config: dict) -> dict:
	"""The version's rules, inserted once and inactive; an operator activates them
	(audit.activate_rules). The database applies them to the stored answers."""
	table = audit(client).table('check_rules')
	found = table.select('*').eq('version_id', version_row['id']).eq('name', name).execute().data
	if found:
		return found[0]
	return table.insert({'version_id': version_row['id'], 'name': name, 'config': config}).execute().data[0]


def claim_next(client, version_ids) -> dict | None:
	"""The oldest queued run of the most urgent queue for one of these versions, now running."""
	for name in QUEUE_ORDER:
		candidates = (
			audit(client)
			.table('runs')
			.select('*')
			.eq('status', 'queued')
			.eq('queue', name)
			.in_('version_id', list(version_ids))
			.order('created_at')
			.order('id')
			.limit(5)
			.execute()
			.data
		)
		for run in candidates:
			claimed = (
				audit(client)
				.table('runs')
				.update({'status': 'running', 'started_at': now(), 'attempts': run['attempts'] + 1})
				.eq('id', run['id'])
				.eq('status', 'queued')
				.execute()
				.data
			)
			if claimed:
				return claimed[0]
	return None


def release(client, run: dict, error: str | None = None) -> None:
	"""Back to the queue untouched by the attempt: a pause is not a try."""
	audit(client).table('runs').update(
		{'status': 'queued', 'started_at': None, 'attempts': max(0, run['attempts'] - 1), 'error': error}
	).eq('id', run['id']).execute()


def retry_or_fail(client, run: dict, error: str) -> str:
	if run['attempts'] < MAX_ATTEMPTS:
		audit(client).table('runs').update({'status': 'queued', 'started_at': None, 'error': error}).eq(
			'id', run['id']
		).execute()
		return 'queued'
	audit(client).table('runs').update({'status': 'failed', 'finished_at': now(), 'error': error}).eq(
		'id', run['id']
	).execute()
	return 'failed'


def finish(client, run: dict, result: dict) -> None:
	"""Store the run's tiles, images and judgements and mark it done, all or nothing.
	result is the handler's p_result (audit.finish_run)."""
	audit(client).rpc('finish_run', {'p_run_id': run['id'], 'p_result': result}).execute()


def recover(client, version_ids) -> int:
	"""Runs left running by a worker that stopped: back to the queue, or failed after the last attempt.

	There is one worker; at its start nothing of these versions can still be running. A run
	stores nothing before audit.finish_run, so a retry starts clean.
	"""
	stranded = (
		audit(client)
		.table('runs')
		.select('*')
		.eq('status', 'running')
		.in_('version_id', list(version_ids))
		.execute()
		.data
	)
	for run in stranded:
		retry_or_fail(client, run, 'interrupted: the worker stopped during this run')
	return len(stranded)


def enqueue(
	client, version_row: dict, dataset_ids, queue: str, inputs: dict | None = None, force: bool = False
) -> list[int]:
	"""Queued runs of this version for datasets whose latest run of it judged other inputs, or
	that have none.

	Inputs are what a run judges (ortho sha256, AOI, prediction label ids): a dataset whose
	ortho or predictions were redone gets a new run of the same version. force queues
	regardless, for an explicit rerun. inputs maps a dataset id to its inputs.
	"""
	ids = sorted(set(dataset_ids))
	if not ids:
		return []
	inputs = inputs or {}
	latest = {}
	if not force:
		for start in range(0, len(ids), 500):
			rows = (
				audit(client)
				.table('runs')
				.select('id, dataset_id, inputs')
				.eq('version_id', version_row['id'])
				.in_('dataset_id', ids[start : start + 500])
				.order('id')
				.execute()
				.data
			)
			for r in rows:  # ascending ids: the latest run wins
				latest[r['dataset_id']] = r.get('inputs') or {}
	new = [i for i in ids if i not in latest or latest[i] != inputs.get(i, {})]
	rows = [
		{
			'check_key': version_row['check_key'],
			'version_id': version_row['id'],
			'dataset_id': i,
			'queue': queue,
			'inputs': inputs.get(i, {}),
		}
		for i in new
	]
	for start in range(0, len(rows), 500):
		audit(client).table('runs').insert(rows[start : start + 500]).execute()
	return new


PAGE = 1000


def keyset_pages(base, first: str, second: str, start=None, until=None, page: int | None = None):
	"""All rows of base() ordered by (first, second), page by page, with a keyset cursor.

	first >= start and first < until when given. No row is skipped when many share a value
	of first, and rows never shift between pages the way offsets do.
	"""
	page = page or PAGE
	cursor = None  # (first, second) of the last row returned
	while True:
		rows = []
		if cursor is not None:
			# the rest of the rows that share the cursor's first value
			rows = base().eq(first, cursor[0]).gt(second, cursor[1]).order(second).limit(page).execute().data
		if len(rows) < page:
			later = base()
			if until is not None:
				later = later.lt(first, until)
			if cursor is not None:
				later = later.gt(first, cursor[0])
			elif start is not None:
				later = later.gte(first, start)
			rows += later.order(first).order(second).limit(page - len(rows)).execute().data
		if not rows:
			return
		yield rows
		cursor = (rows[-1][first], rows[-1][second])


def processed_pages(client, since: str, until: str, page: int | None = None):
	"""Status rows of idle, error-free datasets updated in [since, until), page by page."""

	def base():
		return client.table('v2_statuses').select('*').eq('current_status', 'idle').eq('has_error', False)

	yield from keyset_pages(base, 'updated_at', 'dataset_id', start=since, until=until, page=page)
