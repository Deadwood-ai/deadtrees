#!/usr/bin/env python3
"""
Import earlier audit judgements into the audit schema (DT-1487).

audits  Saved dataset_audit rows become person rows marked
        imported_from = 'dataset_audit'. They keep history and the old decisions
        but never count as benchmark truth: the audit is redone for every dataset.
        Rows without an auditor are skipped, and so is phenology until its check
        exists (dataset_audit keeps both).
derive  Writes a crop manifest for the DT-1272 crops whose footprint the database
        can give: the earlier test crops (COG window plus the COG's geotransform)
        and the reference patch crops (the patch footprint). Read-only.
gold    The graded DT-1272 crops become the frozen benchmark pq-gold-dt1272 v1:
        off-grid crops, their stored images, the grader's person rows (benchmark
        truth) and the members with their dev/holdout split.

Every command is a dry run that reads the production database read-only and
reports counts, unless --execute is given. --execute writes in one transaction
with the writer connection named by --db-url-env (the service role, because
imported rows and benchmarks bypass the API roles' policies) and, for gold, first
copies the images with rsync to --image-target. Writing to production needs
explicit approval for that run.

Example:
	python3 scripts/audit_import.py audits
	python3 scripts/audit_import.py derive --root .local/exclusion-benchmark --output test-crops.json
	python3 scripts/audit_import.py gold --root .local/exclusion-benchmark \\
		--manifest gold-manifest.json --manifest test-crops.json --assessor-user-id <uuid>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

import psycopg

ANALYST_ENV = 'DEADTREES_ANALYST_DATABASE_URL'
LEGACY = 'dataset_audit'
BENCHMARK = ('pq-gold-dt1272', 'v1')
STORAGE_PREFIX = 'audit/benchmarks/pq-gold-dt1272'
OVERLAYS = {'deadwood': 'deadwood_overlay', 'forest_cover': 'forest_cover_overlay'}
# DT-1272 crop splits: tune and holdout were frozen by dataset; the later batches
# take the split their dataset already has, else the hash split
SPLITS = {'tune': 'dev', 'holdout': 'holdout'}
LAYER_MODES = {
	'deadwood': (
		'm1_dead_missed',
		'm2_dw_on_live_vegetation',
		'm3_dw_on_non_vegetation',
		'm4_dw_on_lying_wood',
		'm7_dw_artifact',
	),
	'forest_cover': ('m5_fc_trees_missed', 'm6_fc_on_non_trees', 'm7_fc_artifact'),
}
DROPPED_MODES = ('m8_dead_not_forest',)  # dropped on 19 Oct; kept in details.legacy
VERDICT_KEYS = {'deadwood': 'v_deadwood', 'forest_cover': 'v_forest'}

# One row per saved answer. The prediction judged is the newest model prediction
# of that layer created before the audit.
LEGACY_ROWS_SQL = """
WITH a AS (SELECT * FROM public.dataset_audit WHERE audited_by IS NOT NULL),
label AS (
	SELECT a.dataset_id, layer.name AS layer, (
		SELECT l.id FROM public.v2_labels l
		WHERE l.dataset_id = a.dataset_id AND l.label_source = 'model_prediction'
			AND l.label_data::text = layer.name AND l.created_at <= a.audit_date
		ORDER BY l.created_at DESC, l.id DESC LIMIT 1) AS label_id
	FROM a CROSS JOIN (VALUES ('deadwood'), ('forest_cover')) AS layer(name)
),
rows AS (
	SELECT a.dataset_id, 'georef' AS check_key, 'georef' AS layer, NULL::bigint AS label_id,
		CASE WHEN a.is_georeferenced THEN 'ok' ELSE 'major' END AS verdict, '{}'::jsonb AS modes,
		jsonb_build_object('field', 'is_georeferenced', 'value', a.is_georeferenced) AS details, a.audited_by, a.audit_date
	FROM a WHERE a.is_georeferenced IS NOT NULL
	UNION ALL
	SELECT a.dataset_id, 'acquisition_date', 'acquisition_date', NULL,
		CASE WHEN a.has_valid_acquisition_date THEN 'ok' ELSE 'major' END, '{}'::jsonb,
		jsonb_strip_nulls(jsonb_build_object('field', 'has_valid_acquisition_date', 'value', a.has_valid_acquisition_date,
			'note', a.acquisition_date_notes, 'accept_suggested_date', a.accept_suggested_acquisition_date)),
		a.audited_by, a.audit_date
	FROM a WHERE a.has_valid_acquisition_date IS NOT NULL
	UNION ALL
	SELECT a.dataset_id, 'prediction_quality', 'deadwood', l.label_id,
		CASE a.deadwood_quality WHEN 'great' THEN 'ok' WHEN 'sentinel_ok' THEN 'minor' ELSE 'major' END, '{}'::jsonb,
		jsonb_strip_nulls(jsonb_build_object('field', 'deadwood_quality', 'value', a.deadwood_quality, 'note', a.deadwood_notes)),
		a.audited_by, a.audit_date
	FROM a JOIN label l ON l.dataset_id = a.dataset_id AND l.layer = 'deadwood' WHERE a.deadwood_quality IS NOT NULL
	UNION ALL
	SELECT a.dataset_id, 'prediction_quality', 'forest_cover', l.label_id,
		CASE a.forest_cover_quality WHEN 'great' THEN 'ok' WHEN 'sentinel_ok' THEN 'minor' ELSE 'major' END, '{}'::jsonb,
		jsonb_strip_nulls(jsonb_build_object('field', 'forest_cover_quality', 'value', a.forest_cover_quality,
			'note', a.forest_cover_notes)),
		a.audited_by, a.audit_date
	FROM a JOIN label l ON l.dataset_id = a.dataset_id AND l.layer = 'forest_cover' WHERE a.forest_cover_quality IS NOT NULL
	UNION ALL
	SELECT a.dataset_id, 'dataset_evaluation', 'image', NULL,
		CASE a.final_assessment WHEN 'exclude_completely' THEN 'major' WHEN 'fixable_issues' THEN 'minor' ELSE 'ok' END,
		jsonb_strip_nulls(jsonb_build_object(
			'cog_issue', CASE WHEN a.has_cog_issue THEN true END,
			'thumbnail_issue', CASE WHEN a.has_thumbnail_issue THEN true END,
			'major_issue', CASE WHEN a.has_major_issue THEN true END)),
		jsonb_strip_nulls(jsonb_build_object('field', 'final_assessment', 'value', a.final_assessment, 'note', a.notes,
			'cog_issue_note', a.cog_issue_notes, 'thumbnail_issue_note', a.thumbnail_issue_notes, 'aoi_done', a.aoi_done,
			'reviewed_at', a.reviewed_at, 'reviewed_by', a.reviewed_by)),
		a.audited_by, a.audit_date
	FROM a WHERE a.final_assessment IS NOT NULL
)
SELECT r.* FROM rows r
WHERE NOT EXISTS (
	SELECT 1 FROM audit.assessments x
	WHERE x.imported_from = 'dataset_audit' AND x.dataset_id = r.dataset_id AND x.check_key = r.check_key
		AND x.layer = r.layer AND x.crop_id IS NULL)
"""

INSERT_LEGACY_SQL = f"""
INSERT INTO audit.assessments (check_key, dataset_id, layer, label_id, assessor_kind, assessor_user_id, verdict, modes,
	details, imported_from, created_at)
SELECT check_key, dataset_id, layer, label_id, 'person', audited_by, verdict::audit.verdict, modes,
	details || jsonb_build_object('source', 'dataset_audit'), 'dataset_audit', audit_date
FROM ({LEGACY_ROWS_SQL}) legacy
"""


def connect(env_name: str, read_only: bool) -> psycopg.Connection:
	url = os.environ.get(env_name)
	if not url:
		raise SystemExit(f'{env_name} is not set')
	conn = psycopg.connect(url, prepare_threshold=None, connect_timeout=10)
	if read_only:
		conn.execute('SET TRANSACTION READ ONLY')
	conn.execute("SET LOCAL statement_timeout = '120s'")
	return conn


# ---------------------------------------------------------------------------
# Saved audits
# ---------------------------------------------------------------------------


def plan_audits(conn) -> dict:
	"""What an import would write now, by check, layer and verdict, plus what it skips."""
	rows = conn.execute(
		f'SELECT check_key, layer, verdict, count(*) FROM ({LEGACY_ROWS_SQL}) r GROUP BY 1, 2, 3 ORDER BY 1, 2, 3'
	).fetchall()
	skipped = conn.execute(
		'SELECT count(*) FILTER (WHERE audited_by IS NULL), count(*) FILTER (WHERE has_valid_phenology IS NOT NULL), count(*) '
		'FROM public.dataset_audit'
	).fetchone()
	return {
		'rows': {f'{c}/{layer}/{verdict}': n for c, layer, verdict, n in rows},
		'total': sum(n for *_, n in rows),
		'audits': skipped[2],
		'skipped_without_auditor': skipped[0],
		'phenology_not_imported': skipped[1],
	}


def import_audits(conn) -> int:
	return conn.execute(INSERT_LEGACY_SQL).rowcount


# ---------------------------------------------------------------------------
# Crop manifest for the crops the database can place
# ---------------------------------------------------------------------------


def test_crop_entries(conn, root: Path, crops: list[dict]) -> tuple[list[dict], list[str]]:
	"""Earlier test crops (datasets/<id>/<view>-*) and reference patch crops (patch-truth/<id>/)."""
	entries, problems = [], []
	for crop in crops:
		prefix = crop['prefix']
		files = {
			'raw': f'{prefix}raw.jpg',
			'deadwood_overlay': f'{prefix}deadwood-fill.png',
			'forest_cover_overlay': f'{prefix}forest_cover-fill.png',
		}
		if prefix.startswith('datasets/'):
			evidence = json.loads((root / 'datasets' / str(crop['dataset_id']) / 'evidence.json').read_text())
			view = next((v for v in evidence['views'] if v['name'] == crop['view']), None)
			cog = conn.execute(
				"SELECT cog_path, version, cog_info->'GEO' FROM public.v2_cogs WHERE dataset_id = %s",
				(crop['dataset_id'],),
			).fetchone()
			if view is None or cog is None or (cog[0], cog[1]) != (evidence['cog']['path'], evidence['cog']['version']):
				problems.append(f'{crop["id"]}: the COG changed since the crop was cut')
				continue
			geo = cog[2]
			x0, y0, width, height = view['window']  # rasterio Window: column, row, width, height
			x1, y1 = x0 + width, y0 + height
			ox, oy = geo['Origin']
			rx, ry = geo['Resolution']
			srid = int(geo['CRS'].split(':')[1])
			footprint = conn.execute(
				'SELECT ST_AsGeoJSON(ST_Transform(ST_MakeEnvelope(%s, %s, %s, %s, %s), 4326))::jsonb',
				(ox + x0 * rx, oy + y1 * ry, ox + x1 * rx, oy + y0 * ry, srid),
			).fetchone()[0]
			labels = evidence['label_ids']
			size = view['size'][0]
		elif prefix.startswith('patch-truth/'):
			patch_id = int(prefix.split('/')[1])
			truth = json.loads((root / prefix / 'truth.json').read_text())
			row = conn.execute(
				'SELECT ST_AsGeoJSON(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(geometry::text), epsg_code), 4326))::jsonb '
				'FROM public.reference_patches WHERE id = %s AND dataset_id = %s',
				(patch_id, crop['dataset_id']),
			).fetchone()
			if row is None:
				problems.append(f'{crop["id"]}: reference patch {patch_id} is missing')
				continue
			footprint, labels, size = row[0], None, truth['size'][0]
		else:
			continue
		entries.append(
			{
				'gold_id': crop['id'],
				'dataset_id': crop['dataset_id'],
				'footprint': footprint,
				'mpp': crop['mpp'],
				'size_px': size,
				'label_ids': labels,
				'files': files,
			}
		)
	return entries, problems


# ---------------------------------------------------------------------------
# Gold crops
# ---------------------------------------------------------------------------


def person_rows(answers: dict, label_ids: dict) -> list[dict]:
	"""A graded crop's answers as person rows: the m0 gate, then each judged layer."""
	assessable = answers.get('m0_assessable')
	rows = []
	if assessable is not None:
		rows.append(
			{
				'layer': 'image',
				'label_id': None,
				'verdict': 'ok' if assessable else 'major',
				'modes': {} if assessable else {'m0_not_assessable': True},
			}
		)
	for layer, modes in LAYER_MODES.items():
		verdict = answers.get(VERDICT_KEYS[layer])
		if verdict not in ('ok', 'minor', 'major'):
			continue
		rows.append(
			{
				'layer': layer,
				'label_id': (label_ids or {}).get(layer),
				'verdict': verdict,
				'modes': {m: True for m in modes if answers.get(m) is True},
				'unsure_modes': [m for m in modes if answers.get(m) == 'unsure'],
				'legacy': {m: answers[m] for m in DROPPED_MODES if layer == 'forest_cover' and m in answers},
			}
		)
	return rows


def hash_split(dataset_id: int) -> str:
	"""Same rule as audit.benchmark_split."""
	value = int(hashlib.md5(f'audit-split-v1:{dataset_id}'.encode()).hexdigest()[:8], 16)
	return 'holdout' if value % 5 == 0 else 'dev'


def member_splits(crops: list[dict]) -> dict[str, str]:
	"""tune -> dev, holdout -> holdout; later batches follow their dataset, else the hash."""
	by_dataset = {}
	for crop in crops:
		if crop['split'] in SPLITS:
			by_dataset.setdefault(crop['dataset_id'], set()).add(SPLITS[crop['split']])
	splits = {}
	for crop in crops:
		known = by_dataset.get(crop['dataset_id'], set())
		if len(known) > 1:
			raise ValueError(f'dataset {crop["dataset_id"]} sits on both sides of the frozen split')
		splits[crop['id']] = (
			SPLITS.get(crop['split']) or (known and next(iter(known))) or hash_split(crop['dataset_id'])
		)
	return splits


def load_labels(path: Path) -> dict[str, dict]:
	db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
	try:
		return {
			crop_id: dict(json.loads(payload), graded_at=at)
			for crop_id, payload, at in db.execute('SELECT * FROM labels')
		}
	finally:
		db.close()


def plan_gold(conn, root: Path, manifest: list[dict], labels: dict[str, dict]) -> tuple[list[dict], list[str]]:
	"""Graded crops with everything an import needs; problems name the crops left out."""
	crops = {c['id']: c for c in json.loads((root / 'gold-test.json').read_text())}
	entries = {e['gold_id']: e for e in manifest}
	splits = member_splits([crops[i] for i in labels if i in crops])
	plan, problems = [], []
	for crop_id, label in sorted(labels.items()):
		entry, crop = entries.get(crop_id), crops.get(crop_id)
		if crop is None or entry is None:
			problems.append(f'{crop_id}: not in the manifest')
			continue
		missing = [k for k in ('footprint', 'mpp', 'size_px', 'files') if not entry.get(k)]
		if missing:
			problems.append(f'{crop_id}: manifest lacks {", ".join(missing)}')
			continue
		ortho = conn.execute(
			'SELECT sha256, created_at FROM public.v2_orthos WHERE dataset_id = %s', (crop['dataset_id'],)
		).fetchone()
		if ortho is None or ortho[1] > datetime.fromisoformat(label['graded_at']):
			problems.append(f'{crop_id}: the ortho was replaced after grading')
			continue
		label_ids = entry.get('label_ids') or derived_labels(conn, crop['dataset_id'], label['graded_at'])
		files = {}
		for kind, name in entry['files'].items():
			path = root / name
			if not path.is_file():
				problems.append(f'{crop_id}: missing image {name}')
				break
			files[kind] = path
		else:
			plan.append(
				{
					'gold_id': crop_id,
					'dataset_id': crop['dataset_id'],
					'ortho_sha256': ortho[0],
					'footprint': entry['footprint'],
					'mpp': entry['mpp'],
					'size_px': entry['size_px'],
					'label_ids': label_ids,
					'labels_derived': not entry.get('label_ids'),
					'files': files,
					'split': splits[crop_id],
					'selection': {'picker': 'dt1272-gold', 'view': crop['view'], 'source': crop['source']},
					'label': label,
				}
			)
	return plan, problems


def derived_labels(conn, dataset_id: int, graded_at: str) -> dict:
	"""The preferred model prediction per layer at grading time, as the DT-1272 renders used."""
	rows = conn.execute(
		"""SELECT DISTINCT ON (l.label_data) l.label_data::text, l.id FROM public.v2_labels l
		WHERE l.dataset_id = %s AND l.label_source = 'model_prediction' AND l.label_data IN ('deadwood', 'forest_cover')
			AND l.created_at <= %s
			AND EXISTS (SELECT 1 FROM public.v2_model_preferences p
				WHERE p.label_data = l.label_data::text AND l.model_config @> p.model_config)
		ORDER BY l.label_data, l.created_at DESC, l.id DESC""",
		(dataset_id, graded_at),
	).fetchall()
	return dict(rows)


def image_rows(item: dict) -> list[dict]:
	from PIL import Image

	rows = []
	for kind, path in item['files'].items():
		layer = next((layer for layer, k in OVERLAYS.items() if k == kind), None)
		label_id = item['label_ids'].get(layer) if layer else None
		if layer and label_id is None:
			continue
		with Image.open(path) as image:
			width, height = image.size
		data = path.read_bytes()
		rows.append(
			{
				'kind': kind,
				'label_id': label_id,
				'storage_path': f'{STORAGE_PREFIX}/{item["gold_id"]}/{path.name}',
				'content_type': 'image/jpeg' if path.suffix == '.jpg' else 'image/png',
				'width': width,
				'height': height,
				'bytes': len(data),
				'sha256': hashlib.sha256(data).hexdigest(),
				'source': path,
			}
		)
	return rows


def summarize_gold(plan: list[dict], problems: list[str]) -> dict:
	rows = Counter(
		f'{r["layer"]}/{r["verdict"]}'
		for item in plan
		for r in person_rows(item['label']['answers'], item['label_ids'])
	)
	return {
		'crops': len(plan),
		'datasets': len({i['dataset_id'] for i in plan}),
		'splits': dict(Counter(i['split'] for i in plan)),
		'labels_derived_from_time': sum(i['labels_derived'] for i in plan),
		'person_rows': dict(sorted(rows.items())),
		'skipped': len(problems),
		'problems': problems,
	}


def import_gold(conn, plan: list[dict], assessor: str) -> int:
	"""Benchmark, crops, images, person rows and members in the caller's transaction, then freeze."""
	if conn.execute('SELECT 1 FROM audit.benchmarks WHERE name = %s AND version = %s', BENCHMARK).fetchone():
		raise SystemExit(f'benchmark {BENCHMARK[0]} {BENCHMARK[1]} already exists')
	benchmark = conn.execute(
		'INSERT INTO audit.benchmarks (check_key, name, version, description, created_by) '
		"VALUES ('prediction_quality', %s, %s, %s, %s) RETURNING id",
		(*BENCHMARK, 'Crops graded on the DT-1272 labeling page (tune/holdout frozen by dataset)', assessor),
	).fetchone()[0]
	for item in plan:
		crop = conn.execute(
			'INSERT INTO audit.crops (dataset_id, ortho_sha256, crop_sets, geometry, mpp, size_px, selection) '
			"VALUES (%s, %s, '{benchmark}', ST_GeomFromGeoJSON(%s), %s, %s, %s) RETURNING id",
			(
				item['dataset_id'],
				item['ortho_sha256'],
				json.dumps(item['footprint']),
				item['mpp'],
				item['size_px'],
				json.dumps({'benchmark': {**item['selection'], 'gold_id': item['gold_id']}}),
			),
		).fetchone()[0]
		for image in image_rows(item):
			conn.execute(
				'INSERT INTO audit.images (dataset_id, ortho_sha256, crop_id, label_id, kind, storage_path, content_type, '
				'width, height, mpp, bytes, sha256) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)',
				(
					item['dataset_id'],
					item['ortho_sha256'],
					crop,
					image['label_id'],
					image['kind'],
					image['storage_path'],
					image['content_type'],
					image['width'],
					image['height'],
					item['mpp'],
					image['bytes'],
					image['sha256'],
				),
			)
		label = item['label']
		for row in person_rows(label['answers'], item['label_ids']):
			details = {
				'source': 'dt1272-gold-labels',
				'gold_id': item['gold_id'],
				'note': label.get('note') or None,
				'sizes': label.get('sizes') or None,
				'unsure_modes': row.get('unsure_modes') or None,
				'legacy': {**(label.get('legacy') or {}), **row.get('legacy', {})} or None,
				'label_derived': item['labels_derived'] or None,
			}
			conn.execute(
				'INSERT INTO audit.assessments (check_key, dataset_id, crop_id, layer, label_id, assessor_kind, '
				"assessor_user_id, verdict, modes, details, created_at) VALUES ('prediction_quality', %s, %s, %s, %s, "
				"'person', %s, %s, %s, %s, %s)",
				(
					item['dataset_id'],
					crop,
					row['layer'],
					row['label_id'],
					assessor,
					row['verdict'],
					json.dumps(row['modes']),
					json.dumps({k: v for k, v in details.items() if v is not None}),
					label['graded_at'],
				),
			)
		conn.execute(
			'INSERT INTO audit.benchmark_members (benchmark_id, dataset_id, crop_id, split) VALUES (%s, %s, %s, %s)',
			(benchmark, item['dataset_id'], crop, item['split']),
		)
	conn.execute('UPDATE audit.benchmarks SET frozen_at = now() WHERE id = %s', (benchmark,))
	return benchmark


def copy_images(plan: list[dict], target: str) -> None:
	"""Copy every image to <target>/<storage path> before the rows that point at it exist."""
	for item in plan:
		for image in image_rows(item):
			destination = f'{target.rstrip("/")}/{image["storage_path"]}'
			subprocess.run(['rsync', '-a', '--mkpath', str(image['source']), destination], check=True)


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	sub = parser.add_subparsers(dest='command', required=True)
	for name in ('audits', 'derive', 'gold'):
		p = sub.add_parser(name)
		p.add_argument('--read-env', default=ANALYST_ENV, help='read-only connection for dry runs (env var name)')
		if name != 'derive':
			p.add_argument('--execute', action='store_true', help='write; needs approval for this run')
			p.add_argument('--db-url-env', help='env var with the writer connection, required with --execute')
		if name != 'audits':
			p.add_argument('--root', type=Path, required=True, help='the DT-1272 benchmark folder')
	sub.choices['derive'].add_argument('--output', type=Path, required=True)
	gold = sub.choices['gold']
	gold.add_argument('--manifest', type=Path, action='append', required=True)
	gold.add_argument('--labels', type=Path, help='defaults to <root>/gold-labels.sqlite3')
	gold.add_argument('--assessor-user-id', required=True, help='the person who graded the crops')
	gold.add_argument('--image-target', help='rsync destination of the storage data directory, required with --execute')
	args = parser.parse_args(argv)

	if getattr(args, 'execute', False):
		if not args.db_url_env or args.db_url_env == ANALYST_ENV:
			parser.error('--execute needs --db-url-env naming a writer connection')
		if args.command == 'gold' and not args.image_target:
			parser.error('gold --execute needs --image-target')
	writing = getattr(args, 'execute', False)
	conn = connect(args.db_url_env if writing else args.read_env, read_only=not writing)
	try:
		if args.command == 'audits':
			report = plan_audits(conn)
			if writing:
				report['inserted'] = import_audits(conn)
		elif args.command == 'derive':
			crops = json.loads((args.root / 'gold-test.json').read_text())
			entries, problems = test_crop_entries(conn, args.root, crops)
			args.output.write_text(json.dumps(entries, indent=1))
			report = {'entries': len(entries), 'problems': problems, 'output': str(args.output)}
		else:
			manifest = [e for path in args.manifest for e in json.loads(path.read_text())]
			labels = load_labels(args.labels or args.root / 'gold-labels.sqlite3')
			plan, problems = plan_gold(conn, args.root, manifest, labels)
			report = summarize_gold(plan, problems)
			if writing:
				copy_images(plan, args.image_target)
				report['benchmark_id'] = import_gold(conn, plan, args.assessor_user_id)
		if writing:
			conn.commit()
		else:
			conn.rollback()
	except BaseException:
		conn.rollback()
		raise
	finally:
		conn.close()
	print(json.dumps(report, indent=1, default=str))
	return 0


if __name__ == '__main__':
	sys.exit(main())
