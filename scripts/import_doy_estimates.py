#!/usr/bin/env python3
"""
Import acquisition-date estimates computed outside the processor (DT-1408).

The v2 date model was trained on most datasets that already exist, so the
processor's estimates for them would be in-sample. Those datasets were run once,
outside the queue, with the cross-validation fold model that never saw them
(the rest with the deployed v2 model); see docs/doy-estimation.md. This writes
that run's rows the way the processor's stage writes its own
(process_doy_estimation._store / _clear):

- v2_acquisition_date_estimates: upsert on dataset_id. The AFTER trigger
  supersede_contradicted_date_decision fires per row as for a processor run.
- dataset_audit_suggestions: upsert on (dataset_id, field); the stage's fields
  that a row no longer suggests are deleted, for any doy_estimation_* source.
- v2_statuses.is_doy_estimation_done = true.
- clears.jsonl (no year / ortho not sampleable): the estimate and the stage's
  suggestions are deleted.

A row is written only while it still describes the dataset: not archived, the
recorded date unchanged since the run, and no estimate newer than the row (a
processor run after the import's run wins). Re-running the same bundle writes
nothing new.

Input: a bundle directory with estimates.jsonl and suggestions.jsonl (rows as
process_doy_estimation.estimate_row / suggestion_rows build them) and,
optionally, clears.jsonl ({"dataset_id", "recorded_year", "recorded_month",
"recorded_day"}).

By default this is a dry run: with the analyst login it loads the bundle into
temporary tables and reports what would be written and
which active date decisions the trigger would reopen. --rehearse runs the
writes with --db-url-env and rolls back; --execute commits, one transaction per
--batch datasets. Writing to production needs explicit approval for that run
(docs/playbooks/approved-production-writes.md).

Example:
	python3 scripts/import_doy_estimates.py .local/doy-oof-bundle
	python3 scripts/import_doy_estimates.py .local/doy-oof-bundle --rehearse --db-url-env DEADTREES_WRITE_DATABASE_URL
	python3 scripts/import_doy_estimates.py .local/doy-oof-bundle --execute --db-url-env DEADTREES_WRITE_DATABASE_URL
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path

import psycopg

ANALYST_ENV = 'DEADTREES_ANALYST_DATABASE_URL'
SOURCE_PREFIX = 'doy_estimation'
# processor/src/process_doy_estimation.SUGGESTED_FIELDS
SUGGESTED_FIELDS = ('has_valid_acquisition_date', 'acquisition_date_notes', 'accept_suggested_acquisition_date')
# keys of process_doy_estimation.estimate_row, in table column order
ESTIMATE_COLUMNS = (
	'dataset_id',
	'model_version',
	'model_type',
	'probabilities',
	'flight_year',
	'recorded_year',
	'recorded_month',
	'recorded_day',
	'recorded_precision',
	'predicted_date',
	'mode_date',
	'hdi',
	'hdi80_days',
	'n_modes',
	'recorded_surprise',
	'recorded_offset_days',
	'is_mismatch',
	'suggested_date',
	'suggestion_reason',
	'recommend_accept',
	'metadata',
	'updated_at',
)
SUGGESTION_COLUMNS = ('dataset_id', 'field', 'value', 'source', 'reason', 'details', 'updated_at')

STAGE_SQL = """
CREATE TEMP TABLE doy_est_in (dataset_id bigint PRIMARY KEY, row jsonb NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE doy_sug_in (dataset_id bigint, field text, row jsonb NOT NULL, PRIMARY KEY (dataset_id, field)) ON COMMIT DROP;
CREATE TEMP TABLE doy_clr_in (dataset_id bigint PRIMARY KEY, row jsonb NOT NULL) ON COMMIT DROP;
"""

# rows that still describe their dataset: not archived, same recorded date, nothing newer stored
ELIGIBLE_SQL = """
CREATE TEMP TABLE doy_ok ON COMMIT DROP AS
SELECT i.dataset_id, e.model_version AS old_version, e.dataset_id IS NOT NULL AS replaces
FROM doy_est_in i
JOIN public.v2_datasets d ON d.id = i.dataset_id
LEFT JOIN public.v2_acquisition_date_estimates e ON e.dataset_id = i.dataset_id
WHERE NOT coalesce(d.archived, false)
	AND (d.aquisition_year, d.aquisition_month, d.aquisition_day) IS NOT DISTINCT FROM
		((i.row->>'recorded_year')::smallint, (i.row->>'recorded_month')::smallint, (i.row->>'recorded_day')::smallint)
	AND (e.updated_at IS NULL OR e.updated_at < (i.row->>'updated_at')::timestamptz);
CREATE TEMP TABLE doy_clr_ok ON COMMIT DROP AS
SELECT c.dataset_id
FROM doy_clr_in c
JOIN public.v2_datasets d ON d.id = c.dataset_id
WHERE NOT coalesce(d.archived, false)
	AND (d.aquisition_year, d.aquisition_month, d.aquisition_day) IS NOT DISTINCT FROM
		((c.row->>'recorded_year')::smallint, (c.row->>'recorded_month')::smallint, (c.row->>'recorded_day')::smallint);
"""

# supersede_contradicted_date_decision, evaluated against the incoming rows (dry run)
PREDICTED_SUPERSEDE_SQL = """
SELECT count(*)
FROM doy_ok o
JOIN doy_est_in i USING (dataset_id)
JOIN public.acquisition_date_decisions a ON a.dataset_id = o.dataset_id AND a.superseded_at IS NULL
CROSS JOIN LATERAL (SELECT a.date_valid OR coalesce(a.suggestion_decision = 'accepted', false) AS fine,
	(i.row->>'is_mismatch')::boolean AS mismatch, i.row->>'suggestion_reason' AS reason) x
WHERE ((i.row->>'recorded_year')::smallint, (i.row->>'recorded_month')::smallint, (i.row->>'recorded_day')::smallint)
		IS NOT DISTINCT FROM (a.resulting_year, a.resulting_month, a.resulting_day)
	AND ((x.fine AND x.mismatch) OR (NOT x.fine AND NOT x.mismatch AND x.reason IS NULL)
		OR (x.reason = 'missing_month' AND a.suggestion_decision IS NULL))
"""

UPSERT_ESTIMATES_SQL = f"""
INSERT INTO public.v2_acquisition_date_estimates AS e ({', '.join(ESTIMATE_COLUMNS)})
SELECT {', '.join('r.' + c for c in ESTIMATE_COLUMNS)}
FROM doy_ok o
JOIN doy_est_in i USING (dataset_id)
CROSS JOIN LATERAL jsonb_populate_record(NULL::public.v2_acquisition_date_estimates, i.row) r
ON CONFLICT (dataset_id) DO UPDATE SET
	{', '.join(f'{c} = excluded.{c}' for c in ESTIMATE_COLUMNS if c != 'dataset_id')}
"""

DELETE_STALE_SUGGESTIONS_SQL = """
DELETE FROM public.dataset_audit_suggestions s
USING doy_ok o
WHERE s.dataset_id = o.dataset_id
	AND s.source LIKE %(prefix)s
	AND s.field = ANY(%(fields)s)
	AND NOT EXISTS (SELECT 1 FROM doy_sug_in n WHERE n.dataset_id = s.dataset_id AND n.field = s.field)
"""

UPSERT_SUGGESTIONS_SQL = f"""
INSERT INTO public.dataset_audit_suggestions ({', '.join(SUGGESTION_COLUMNS)})
SELECT n.dataset_id, n.field, n.row->'value', n.row->>'source', n.row->>'reason', n.row->'details',
	(n.row->>'updated_at')::timestamptz
FROM doy_sug_in n
JOIN doy_ok o USING (dataset_id)
ON CONFLICT (dataset_id, field) DO UPDATE SET
	value = excluded.value, source = excluded.source, reason = excluded.reason,
	details = excluded.details, updated_at = excluded.updated_at
"""

MARK_DONE_SQL = """
UPDATE public.v2_statuses s SET is_doy_estimation_done = true
FROM (SELECT dataset_id FROM doy_ok UNION SELECT dataset_id FROM doy_clr_ok) o
WHERE s.dataset_id = o.dataset_id AND NOT coalesce(s.is_doy_estimation_done, false)
"""

CLEAR_SQL = """
WITH sug AS (
	DELETE FROM public.dataset_audit_suggestions s USING doy_clr_ok c
	WHERE s.dataset_id = c.dataset_id AND s.source LIKE %(prefix)s AND s.field = ANY(%(fields)s)
	RETURNING 1
), est AS (
	DELETE FROM public.v2_acquisition_date_estimates e USING doy_clr_ok c
	WHERE e.dataset_id = c.dataset_id
	RETURNING 1
)
SELECT (SELECT count(*) FROM sug), (SELECT count(*) FROM est)
"""

# decisions the trigger deactivated in this transaction
SUPERSEDED_SQL = """
SELECT count(*) FROM public.acquisition_date_decisions
WHERE superseded_at = now() AND superseded_reason = 'estimate_contradicts'
"""


def read_jsonl(path: Path) -> list[dict]:
	if not path.exists():
		return []
	with path.open() as f:
		return [json.loads(line) for line in f if line.strip()]


def load_bundle(root: Path) -> tuple[dict[int, dict], dict[int, list[dict]], dict[int, dict]]:
	estimates = {r['dataset_id']: r for r in read_jsonl(root / 'estimates.jsonl')}
	suggestions: dict[int, list[dict]] = {}
	for r in read_jsonl(root / 'suggestions.jsonl'):
		suggestions.setdefault(r['dataset_id'], []).append(r)
	clears = {r['dataset_id']: r for r in read_jsonl(root / 'clears.jsonl')}
	check_bundle(estimates, suggestions, clears)
	return estimates, suggestions, clears


def check_bundle(estimates: dict[int, dict], suggestions: dict[int, list[dict]], clears: dict[int, dict]) -> None:
	"""Refuse a bundle the stage could not have written."""
	if not estimates and not clears:
		raise SystemExit('bundle holds no estimates and no clears')
	for k, r in estimates.items():
		missing = set(ESTIMATE_COLUMNS) - set(r)
		if missing:
			raise SystemExit(f'estimate {k} lacks {sorted(missing)}')
		if len(r['probabilities']) != 365:
			raise SystemExit(f'estimate {k} has {len(r["probabilities"])} probabilities, not 365')
	for k, rows in suggestions.items():
		if k not in estimates:
			raise SystemExit(f'suggestions for {k} without an estimate')
		fields = [r['field'] for r in rows]
		if len(fields) != len(set(fields)) or not set(fields) <= set(SUGGESTED_FIELDS):
			raise SystemExit(f'suggestions for {k}: unexpected fields {fields}')
		if any(not r['source'].startswith(SOURCE_PREFIX) for r in rows):
			raise SystemExit(f'suggestions for {k}: source outside {SOURCE_PREFIX}*')
	both = set(estimates) & set(clears)
	if both:
		raise SystemExit(f'{len(both)} datasets are both estimated and cleared, e.g. {sorted(both)[:5]}')


def connect(env_name: str) -> psycopg.Connection:
	"""A transaction for one batch. Not READ ONLY even for the dry run: staging needs temporary
	tables, which a read-only transaction refuses. The dry run issues no write to a real
	table, always rolls back, and uses the analyst login, which cannot write anyway."""
	url = os.environ.get(env_name)
	if not url:
		raise SystemExit(f'{env_name} is not set')
	conn = psycopg.connect(url, prepare_threshold=None, connect_timeout=10)
	conn.execute("SET LOCAL statement_timeout = '300s'")
	return conn


def stage(conn: psycopg.Connection, ids: list[int], estimates, suggestions, clears) -> None:
	conn.execute(STAGE_SQL)
	with conn.cursor() as cur:
		with cur.copy('COPY doy_est_in (dataset_id, row) FROM STDIN') as copy:
			for k in ids:
				if k in estimates:
					copy.write_row((k, json.dumps(estimates[k])))
		with cur.copy('COPY doy_sug_in (dataset_id, field, row) FROM STDIN') as copy:
			for k in ids:
				for r in suggestions.get(k, []):
					copy.write_row((k, r['field'], json.dumps(r)))
		with cur.copy('COPY doy_clr_in (dataset_id, row) FROM STDIN') as copy:
			for k in ids:
				if k in clears:
					copy.write_row((k, json.dumps(clears[k])))
	conn.execute(ELIGIBLE_SQL)


def plan(conn: psycopg.Connection) -> Counter:
	c = Counter()
	c['rows'] = conn.execute('SELECT count(*) FROM doy_est_in').fetchone()[0]
	c['write'] = conn.execute('SELECT count(*) FROM doy_ok').fetchone()[0]
	c['replace'] = conn.execute('SELECT count(*) FROM doy_ok WHERE replaces').fetchone()[0]
	for version, n in conn.execute('SELECT old_version, count(*) FROM doy_ok WHERE replaces GROUP BY 1'):
		c[f'replace {version}'] = n
	c['skip (archived, date changed or newer estimate)'] = c['rows'] - c['write']
	c['clears'] = conn.execute('SELECT count(*) FROM doy_clr_in').fetchone()[0]
	c['clear'] = conn.execute('SELECT count(*) FROM doy_clr_ok').fetchone()[0]
	c['decisions the trigger would reopen'] = conn.execute(PREDICTED_SUPERSEDE_SQL).fetchone()[0]
	return c


def write(conn: psycopg.Connection) -> Counter:
	c = Counter()
	params = {'prefix': f'{SOURCE_PREFIX}%', 'fields': list(SUGGESTED_FIELDS)}
	c['estimates upserted'] = conn.execute(UPSERT_ESTIMATES_SQL).rowcount
	c['stale suggestions deleted'] = conn.execute(DELETE_STALE_SUGGESTIONS_SQL, params).rowcount
	c['suggestions upserted'] = conn.execute(UPSERT_SUGGESTIONS_SQL).rowcount
	sug, est = conn.execute(CLEAR_SQL, params).fetchone()
	c['cleared suggestions'] += sug
	c['cleared estimates'] += est
	c['statuses marked done'] = conn.execute(MARK_DONE_SQL).rowcount
	c['decisions reopened'] = conn.execute(SUPERSEDED_SQL).fetchone()[0]
	return c


def main() -> int:
	ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	ap.add_argument('bundle', type=Path)
	mode = ap.add_mutually_exclusive_group()
	mode.add_argument('--rehearse', action='store_true', help='write with --db-url-env, then roll back')
	mode.add_argument('--execute', action='store_true', help='write with --db-url-env and commit')
	ap.add_argument('--db-url-env', help='env var with the writer connection (needed for --rehearse/--execute)')
	ap.add_argument('--batch', type=int, default=500, help='datasets per transaction')
	a = ap.parse_args()
	estimates, suggestions, clears = load_bundle(a.bundle)
	ids = sorted(set(estimates) | set(clears))
	writes = a.rehearse or a.execute
	if writes and not a.db_url_env:
		raise SystemExit('--rehearse/--execute need --db-url-env')
	print(
		f'bundle: {len(estimates)} estimates, {sum(map(len, suggestions.values()))} suggestions, {len(clears)} clears'
	)

	total = Counter()
	batches = [ids[i : i + a.batch] for i in range(0, len(ids), a.batch)] if writes else [ids]
	for n, chunk in enumerate(batches, 1):
		with connect(a.db_url_env if writes else ANALYST_ENV) as conn:
			stage(conn, chunk, estimates, suggestions, clears)
			c = plan(conn)
			if writes:
				c.update(write(conn))
				if a.execute:
					conn.commit()
				else:
					conn.rollback()
			else:
				conn.rollback()
		total.update(c)
		if len(batches) > 1:
			print(f'batch {n}/{len(batches)}: {dict(c)}', flush=True)
	label = 'committed' if a.execute else 'rolled back' if a.rehearse else 'dry run, nothing written'
	print(f'{label}:')
	for k, v in sorted(total.items()):
		print(f'  {k}: {v}')
	return 0


if __name__ == '__main__':
	sys.exit(main())
