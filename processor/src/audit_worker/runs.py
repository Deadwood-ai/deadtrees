"""The worker's reads and writes on audit.runs and audit.current_runs (Supabase, as the processor).

New uploads go first, then manual runs, then the backfill; benchmark runs only in a benchmark
session and they never become current. A run is claimed by moving it from queued to running,
so a second worker could never take the same run.
"""

from __future__ import annotations

from datetime import datetime, timezone

QUEUE_ORDER = ('upload', 'manual', 'backfill')
MAX_ATTEMPTS = 3


def now() -> str:
	return datetime.now(timezone.utc).isoformat()


def audit(client):
	return client.schema('audit')


def active_versions(client, checks) -> dict[str, dict]:
	rows = (
		audit(client).table('check_versions').select('*').eq('is_active', True).in_('check_key', list(checks)).execute()
	)
	return {row['check_key']: row for row in rows.data}


def version(client, version_id: int) -> dict:
	return audit(client).table('check_versions').select('*').eq('id', version_id).single().execute().data


def register_version(client, check_key: str, name: str, config: dict) -> dict:
	"""The handler's version, inserted once (review_all, inactive); an operator activates it."""
	table = audit(client).table('check_versions')
	found = table.select('*').eq('check_key', check_key).eq('version', name).execute().data
	if found:
		return found[0]
	return table.insert({'check_key': check_key, 'version': name, 'config': config}).execute().data[0]


def claim_next(client, checks, benchmark: bool = False) -> dict | None:
	"""The oldest queued run of the most urgent queue for one of these checks, now running."""
	queues = ('benchmark',) if benchmark else QUEUE_ORDER
	for name in queues:
		candidates = (
			audit(client)
			.table('runs')
			.select('*')
			.eq('status', 'queued')
			.eq('queue', name)
			.in_('check_key', list(checks))
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


def finish(client, run: dict, summary: dict, active: bool) -> None:
	"""Done; the run counts for its dataset when its version is the active one."""
	update = {'status': 'done', 'finished_at': now(), 'error': None}
	for key in ('coverage', 'cost', 'evidence'):
		if summary.get(key):
			update[key] = summary[key]
	audit(client).table('runs').update(update).eq('id', run['id']).execute()
	if active and run['queue'] != 'benchmark':
		audit(client).table('current_runs').upsert(
			{'dataset_id': run['dataset_id'], 'check_key': run['check_key'], 'run_id': run['id'], 'updated_at': now()},
			on_conflict='dataset_id,check_key',
		).execute()


def enqueue(client, version_row: dict, dataset_ids, queue: str, inputs: dict | None = None) -> list[int]:
	"""Queued runs of this version for the datasets that have none yet (in any state)."""
	ids = sorted(set(dataset_ids))
	if not ids:
		return []
	have = set()
	for start in range(0, len(ids), 500):
		rows = (
			audit(client)
			.table('runs')
			.select('dataset_id')
			.eq('check_version_id', version_row['id'])
			.in_('dataset_id', ids[start : start + 500])
			.execute()
			.data
		)
		have |= {r['dataset_id'] for r in rows}
	new = [i for i in ids if i not in have]
	rows = [
		{
			'check_key': version_row['check_key'],
			'check_version_id': version_row['id'],
			'dataset_id': i,
			'queue': queue,
			'inputs': inputs or {},
		}
		for i in new
	]
	for start in range(0, len(rows), 500):
		audit(client).table('runs').insert(rows[start : start + 500]).execute()
	return new


def recently_processed(client, since: str, limit: int = 1000) -> list[dict]:
	"""Status rows of datasets that finished a processing step since `since` and are idle without error."""
	return (
		client.table('v2_statuses')
		.select('*')
		.gte('updated_at', since)
		.eq('current_status', 'idle')
		.eq('has_error', False)
		.order('updated_at')
		.limit(limit)
		.execute()
		.data
	)
