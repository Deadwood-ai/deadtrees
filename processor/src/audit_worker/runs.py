"""The worker's reads and writes on audit.runs (Supabase, as the processor).

New uploads go first, then manual runs, then the backfill, then prepare runs (the images
without the models, DT-1627). A run is claimed by moving it from
queued to running, so a second worker could never take the same run. A finished run is stored
by audit.finish_run in one transaction; which run counts for a dataset is the database's view
audit.current_runs, so the worker points nothing.
"""

from __future__ import annotations

from datetime import datetime, timezone

QUEUE_ORDER = ('upload', 'manual', 'backfill', 'prepare')
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
	return fail(client, run, error)


def fail(client, run: dict, error: str) -> str:
	"""The running run ends failed with its error; a run that got to its end state meanwhile stays."""
	audit(client).table('runs').update({'status': 'failed', 'finished_at': now(), 'error': error}).eq(
		'id', run['id']
	).eq('status', 'running').execute()
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
