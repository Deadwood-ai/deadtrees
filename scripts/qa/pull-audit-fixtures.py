#!/usr/bin/env python3
"""Copy production datasets with their automated audit results into the isolated local stack,
for developing the Audit Review page (docs/audit-checks.md) on real check output.

Rows keep their production ids, so a local dataset, run or crop matches production one to one.
User columns point at the local QA contributor and auditor. The production side runs in a
read-only transaction as the trusted analyst (docs/playbooks/analyst-database-access.md); the
local side refuses a database that is not on 127.0.0.1 or localhost. Rerunning replaces the
copied rows. The QA reset does not remove them: use --remove.

Usage, after scripts/qa/env.sh up:
	set -a; source .local/supabase/current.env; set +a
	export DEADTREES_ANALYST_DATABASE_URL=...   # from your credential provider; never printed
	venv/bin/python scripts/qa/pull-audit-fixtures.py 101 102 \\
		--files-from user@storage-host:/data --ssh-key ~/.ssh/<read-only key>
Or load an export made elsewhere: a JSON file {"tables": {"schema.table": [row, ...]}} with
the tables below, geometries as hex EWKB (--from-export FILE; no production connection).
Without --files-from only the rows are copied, and the files the rows name are listed.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import psycopg
from psycopg.types.json import Jsonb

CONTRIBUTOR = '00000000-0000-4000-8000-00000000a001'  # the QA contributor owns the copies
AUDITOR = '00000000-0000-4000-8000-00000000a002'  # every person answer becomes the QA auditor's
OWNER_TABLES = {'v2_datasets', 'v2_labels', 'v2_aois'}

IDS = 'dataset_id = any(%(ids)s)'
ACTIVE_LABELS = 'label_id in (select id from public.v2_labels where dataset_id = any(%(ids)s) and is_active)'
# Load order: parents first. Deletion runs in reverse.
TABLES = [
	('audit', 'check_versions', 'true'),
	('audit', 'benchmarks', 'true'),
	('public', 'v2_datasets', 'id = any(%(ids)s)'),
	('public', 'v2_statuses', IDS),
	('public', 'v2_orthos', IDS),
	('public', 'v2_orthos_processed', IDS),
	('public', 'v2_cogs', IDS),
	('public', 'v2_thumbnails', IDS),
	('public', 'v2_metadata', IDS),
	('public', 'v2_aois', IDS),
	('public', 'v2_labels', IDS + ' and is_active'),
	('public', 'v2_deadwood_geometries', ACTIVE_LABELS),
	('public', 'v2_forest_cover_geometries', ACTIVE_LABELS),
	('public', 'v2_georef_checks', IDS),
	('public', 'v2_acquisition_date_estimates', IDS),
	('public', 'acquisition_date_decisions', IDS),
	('public', 'dataset_audit_legacy', IDS),
	('audit', 'runs', IDS),
	('audit', 'current_runs', IDS),
	('audit', 'crops', IDS),
	('audit', 'images', IDS),
	('audit', 'assessments', IDS),
	('audit', 'benchmark_members', IDS),
]
SHARED = {('audit', 'check_versions'), ('audit', 'benchmarks')}  # copied whole, never deleted


def local_db() -> str:
	url = os.environ.get('SUPABASE_DB_URL', '')
	if urlparse(url).hostname not in ('127.0.0.1', 'localhost'):
		sys.exit('Source .local/supabase/current.env first; refusing a non-local SUPABASE_DB_URL.')
	return url


def columns(db, schema: str, table: str) -> list[tuple[str, str]]:
	"""Insertable columns with their type name, in table order."""
	return db.execute(
		"""select column_name, udt_name from information_schema.columns
		where table_schema = %s and table_name = %s and is_generated = 'NEVER'
		order by ordinal_position""",
		(schema, table),
	).fetchall()


def user_columns(db, schema: str, table: str) -> set[str]:
	"""uuid columns that name a user: a foreign key to auth.users, or a user-ish name."""
	rows = db.execute(
		"""select column_name, exists (
			select 1 from pg_constraint c
			join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
			where c.contype = 'f' and c.confrelid = 'auth.users'::regclass
				and c.conrelid = format('%%I.%%I', table_schema, table_name)::regclass
				and a.attname = column_name)
		from information_schema.columns
		where table_schema = %s and table_name = %s and udt_name = 'uuid'""",
		(schema, table),
	).fetchall()
	return {name for name, is_fk in rows if is_fk or name == 'user_id' or name.endswith('_by') or name.endswith('user_id')}


def fetch(prod, schema: str, table: str, where: str, ids: list[int]) -> list[dict]:
	"""Rows as JSON objects; geometries as hex EWKB so they load back unchanged."""
	geoms = [c for c, udt in columns(prod, schema, table) if udt in ('geometry', 'geography')]
	extra = ''.join(f", '{g}', encode(st_asewkb(t.{g}::geometry), 'hex')" for g in geoms)
	select = f'to_jsonb(t) || jsonb_build_object(\'_\', null{extra})' if geoms else 'to_jsonb(t)'
	sql = f'select {select} from {schema}.{table} t where {where}'
	return [row[0] for row in prod.execute(sql, {'ids': ids}).fetchall()]


def load(local, schema: str, table: str, rows: list[dict]) -> None:
	cols = [c for c, _ in columns(local, schema, table)]
	users = user_columns(local, schema, table)
	for row in rows:
		row.pop('_', None)
		for col in users & row.keys():
			if row[col] is not None:
				row[col] = CONTRIBUTOR if table in OWNER_TABLES and col == 'user_id' else AUDITOR
	names = ', '.join(f'"{c}"' for c in cols)
	local.execute(
		f'insert into {schema}.{table} ({names}) overriding system value '
		f'select {names} from jsonb_populate_recordset(null::{schema}.{table}, %s) '
		f'on conflict do nothing',
		(Jsonb(rows),),
	)


def bump_sequences(local) -> None:
	"""Move every sequence past the copied ids, so local inserts never collide with them."""
	for seq_schema, seq, schema, table, col in local.execute(
		"""select s.relnamespace::regnamespace::text, s.relname, t.relnamespace::regnamespace::text, t.relname, a.attname
		from pg_depend d
		join pg_class s on s.oid = d.objid and s.relkind = 'S'
		join pg_class t on t.oid = d.refobjid
		join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
		where t.relnamespace::regnamespace::text in ('public', 'audit')"""
	).fetchall():
		local.execute(
			f'select setval(%s, greatest((select coalesce(max("{col}"), 0) from {schema}.{table}), '
			f'(select last_value from {seq_schema}.{seq})))',
			(f'{seq_schema}.{seq}',),
		)


def remove(local, ids: list[int]) -> None:
	for schema, table, where in reversed(TABLES):
		if (schema, table) not in SHARED:
			local.execute(f'delete from {schema}.{table} where {where}', {'ids': ids})


def files(local, ids: list[int]) -> list[str]:
	"""Paths below the data directory that the copied rows name."""
	rows = local.execute(
		"""select 'cogs/' || cog_path from public.v2_cogs where dataset_id = any(%(ids)s)
		union all select 'thumbnails/' || thumbnail_path from public.v2_thumbnails where dataset_id = any(%(ids)s)
		union all select storage_path from audit.images where dataset_id = any(%(ids)s)""",
		{'ids': ids},
	).fetchall()
	return sorted(path for (path,) in rows if path)


def pull_files(paths: list[str], remote: str, key: str | None, data_root: str) -> None:
	"""One rsync over one SSH connection; files already present are skipped."""
	with tempfile.NamedTemporaryFile('w', suffix='.txt') as listing:
		listing.write('\n'.join(paths) + '\n')
		listing.flush()
		ssh = 'ssh -o BatchMode=yes' + (f' -i {key}' if key else '')
		subprocess.run(
			['rsync', '-a', '--ignore-existing', '--files-from', listing.name, '-e', ssh, remote.rstrip('/') + '/', data_root.rstrip('/') + '/'],
			check=True,
		)


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument('ids', nargs='*', type=int, help='production dataset ids (default with --from-export: its ids)')
	parser.add_argument('--from-export', metavar='FILE', help='load rows from an export file instead of production')
	parser.add_argument('--remove', action='store_true', help='delete the local copies of these datasets and stop')
	parser.add_argument('--files-from', metavar='USER@HOST:/DATA', help='production data directory to pull the files from')
	parser.add_argument('--ssh-key', help='SSH key for --files-from')
	args = parser.parse_args()
	data_root = os.environ.get('LOCAL_DATA_ROOT') or sys.exit('LOCAL_DATA_ROOT is not set; source .local/supabase/current.env')
	export = json.loads(Path(args.from_export).read_text()) if args.from_export else None
	if export and not args.ids:
		args.ids = export['dataset_ids']
	if not args.ids:
		sys.exit('Name the dataset ids.')

	with psycopg.connect(local_db(), autocommit=False) as local:
		local.execute("set session_replication_role = replica")  # copies, not new events: no triggers, no FK order
		remove(local, args.ids)
		if args.remove:
			local.commit()
			print(f'Removed local copies of {len(args.ids)} datasets.')
			return 0
		if export:
			for schema, table, _ in TABLES:
				rows = export['tables'].get(f'{schema}.{table}', [])
				if rows:
					load(local, schema, table, rows)
				print(f'{schema}.{table}: {len(rows)}')
		else:
			prod_url = os.environ.get('DEADTREES_ANALYST_DATABASE_URL') or sys.exit('DEADTREES_ANALYST_DATABASE_URL is not set')
			with psycopg.connect(prod_url, prepare_threshold=None, connect_timeout=10, autocommit=True) as prod:
				prod.execute('begin read only')
				prod.execute("set local statement_timeout = '120s'")
				for schema, table, where in TABLES:
					rows = fetch(prod, schema, table, where, args.ids)
					if rows:
						load(local, schema, table, rows)
					print(f'{schema}.{table}: {len(rows)}')
				prod.execute('rollback')
		bump_sequences(local)
		local.commit()
		paths = files(local, args.ids)

	print(f'{len(paths)} files named by the copied rows.')
	if args.files_from:
		pull_files(paths, args.files_from, args.ssh_key, data_root)
		missing = [p for p in paths if not (Path(data_root) / p).exists()]
		print(f'Files present locally: {len(paths) - len(missing)} of {len(paths)}')
	else:
		print('Pass --files-from to pull them; the list:')
		print('\n'.join(paths))
	return 0


if __name__ == '__main__':
	sys.exit(main())
