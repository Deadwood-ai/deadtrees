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
	"""Done; the run counts for its dataset when its version is the active one.

	The pointer is a second request. If it does not land, publish() puts it right on the
	next sweep with the same rule.
	"""
	update = {'status': 'done', 'finished_at': now(), 'error': None}
	for key in ('coverage', 'cost', 'evidence'):
		if summary.get(key):
			update[key] = summary[key]
	audit(client).table('runs').update(update).eq('id', run['id']).execute()
	if active and run['queue'] != 'benchmark':
		point(client, run)


def replaces(pointed: dict | None, run: dict) -> bool:
	"""The pointer rule, for a done run of the active version.

	It replaces a missing pointer, or one at another version's run (a promotion wins
	whatever the ids), and within its own version only an older run: the run created
	later judged the later evidence, whichever finished first.
	"""
	if pointed is None or pointed['check_version_id'] != run['check_version_id']:
		return True
	return run['id'] > pointed['id']


def point(client, run: dict) -> bool:
	"""Apply the pointer rule. The update only lands if the pointer is still the one read,
	so two writers cannot undo each other; on a lost race it reads again."""
	pointers = audit(client).table('current_runs')
	for _ in range(3):
		current = (
			pointers.select('run_id')
			.eq('dataset_id', run['dataset_id'])
			.eq('check_key', run['check_key'])
			.execute()
			.data
		)
		if not current:
			try:
				pointers.insert(
					{
						'dataset_id': run['dataset_id'],
						'check_key': run['check_key'],
						'run_id': run['id'],
						'updated_at': now(),
					}
				).execute()
				return True
			except Exception:  # someone else pointed first: decide again on what is there now
				continue
		old = current[0]['run_id']
		pointed = audit(client).table('runs').select('id, check_version_id').eq('id', old).execute().data
		if not replaces(pointed[0] if pointed else None, run):
			return False
		moved = (
			pointers.update({'run_id': run['id'], 'updated_at': now()})
			.eq('dataset_id', run['dataset_id'])
			.eq('check_key', run['check_key'])
			.eq('run_id', old)
			.execute()
			.data
		)
		if moved:
			return True
	return False


def publish(client, version_row: dict, since: str) -> int:
	"""Apply the pointer rule to each dataset's newest done run of the active version."""
	done = (
		audit(client)
		.table('runs')
		.select('id, dataset_id, check_key, check_version_id, queue')
		.eq('check_version_id', version_row['id'])
		.eq('status', 'done')
		.gte('finished_at', since)
		.execute()
		.data
	)
	newest = {}
	for run in done:
		if run['queue'] != 'benchmark' and run['id'] > newest.get(run['dataset_id'], {}).get('id', 0):
			newest[run['dataset_id']] = run
	return sum(point(client, run) for run in newest.values())


def recover(client, checks) -> int:
	"""Runs left running by a worker that stopped: back to the queue, or failed after the last attempt.

	There is one worker; at its start nothing of these checks can still be running. A handler
	writes crops and images idempotently, and a repeated model answer only adds a newer row.
	"""
	stranded = (
		audit(client).table('runs').select('*').eq('status', 'running').in_('check_key', list(checks)).execute().data
	)
	for run in stranded:
		retry_or_fail(client, run, 'interrupted: the worker stopped during this run')
	return len(stranded)


def enqueue(
	client, version_row: dict, dataset_ids, queue: str, inputs: dict | None = None, force: bool = False
) -> list[int]:
	"""Queued runs of this version for datasets without one on the same evidence.

	Evidence is the run's inputs (ortho sha256, prediction label ids): a dataset whose
	predictions were rerun gets a new run of the same version. Benchmark runs are scheduled
	on their own and never stop a production run, nor the other way round. force queues
	regardless, for an explicit rerun. inputs maps a dataset id to its inputs.
	"""
	ids = sorted(set(dataset_ids))
	if not ids:
		return []
	inputs = inputs or {}
	have = set()
	if not force:
		for start in range(0, len(ids), 500):
			rows = (
				audit(client)
				.table('runs')
				.select('dataset_id, queue, inputs')
				.eq('check_version_id', version_row['id'])
				.in_('dataset_id', ids[start : start + 500])
				.execute()
				.data
			)
			have |= {
				r['dataset_id']
				for r in rows
				if (r['queue'] == 'benchmark') == (queue == 'benchmark')
				and (r.get('inputs') or {}) == inputs.get(r['dataset_id'], {})
			}
	new = [i for i in ids if i not in have]
	rows = [
		{
			'check_key': version_row['check_key'],
			'check_version_id': version_row['id'],
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


def processed_pages(client, since: str, until: str, page: int | None = None):
	"""Status rows of idle, error-free datasets updated in [since, until), page by page.

	Ordered by (updated_at, dataset_id) with a keyset cursor, so no row is skipped when
	many share one timestamp and nothing moves between pages.
	"""
	page = page or PAGE

	def base():
		return client.table('v2_statuses').select('*').eq('current_status', 'idle').eq('has_error', False)

	cursor_at, cursor_id = since, None
	while True:
		rows = []
		if cursor_id is not None:
			# the rest of the rows that share the cursor's timestamp
			rows = (
				base()
				.eq('updated_at', cursor_at)
				.gt('dataset_id', cursor_id)
				.order('dataset_id')
				.limit(page)
				.execute()
				.data
			)
		if len(rows) < page:
			later = base().lt('updated_at', until)
			later = later.gt('updated_at', cursor_at) if cursor_id is not None else later.gte('updated_at', cursor_at)
			rows += later.order('updated_at').order('dataset_id').limit(page - len(rows)).execute().data
		if not rows:
			return
		yield rows
		cursor_at, cursor_id = rows[-1]['updated_at'], rows[-1]['dataset_id']
