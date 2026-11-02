"""Importing the saved audits and the DT-1272 gold crops into the audit schema (scripts/audit_import.py)."""

import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest
from PIL import Image

from api.tests.db.test_acquisition_date_estimates import create_dataset, create_user, db  # noqa: F401

SCRIPT = Path(__file__).parents[3] / 'scripts' / 'audit_import.py'
SPEC = importlib.util.spec_from_file_location('audit_import', SCRIPT)
audit_import = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit_import)

SHA = 'c' * 64
GRADED_AT = '2026-10-13T08:13:43+00:00'


def add_label(db, dataset, owner, layer, created_at):
	return db.execute(
		'INSERT INTO public.v2_labels(dataset_id,user_id,label_source,label_type,label_data,created_at) '
		"VALUES (%s,%s,'model_prediction','semantic_segmentation',%s,%s) RETURNING id",
		(dataset, owner, layer, created_at),
	).fetchone()[0]


def imported(db, dataset):
	return db.execute(
		'SELECT check_key,layer,verdict,label_id,modes,details->>%s FROM audit.assessments '
		"WHERE dataset_id=%s AND imported_from='dataset_audit' ORDER BY check_key,layer",
		('note', dataset),
	).fetchall()


def test_saved_audits_become_marked_person_rows_once(db):
	auditor, owner = create_user(db, can_audit=True), create_user(db)
	full, excluded, unattributed = (create_dataset(db, owner) for _ in range(3))
	before, after = (
		add_label(db, full, owner, 'deadwood', '2026-01-01'),
		add_label(db, full, owner, 'deadwood', '2026-03-01'),
	)
	db.execute(
		'INSERT INTO public.dataset_audit(dataset_id,audited_by,audit_date,is_georeferenced,has_valid_acquisition_date,'
		'acquisition_date_notes,has_valid_phenology,deadwood_quality,deadwood_notes,forest_cover_quality,final_assessment,'
		"has_cog_issue,notes) VALUES (%s,%s,'2026-02-01',true,false,'flown in May',true,'sentinel_ok','misses snags','bad',"
		"'fixable_issues',true,'check COG')",
		(full, auditor),
	)
	db.execute(
		"INSERT INTO public.dataset_audit(dataset_id,audited_by,final_assessment) VALUES (%s,%s,'exclude_completely')",
		(excluded, auditor),
	)
	db.execute("INSERT INTO public.dataset_audit(dataset_id,final_assessment) VALUES (%s,'no_issues')", (unattributed,))

	plan = audit_import.plan_audits(db)
	assert plan['skipped_without_auditor'] >= 1 and plan['phenology_not_imported'] >= 1
	assert audit_import.import_audits(db) == plan['total']
	assert imported(db, full) == [
		('acquisition_date', 'acquisition_date', 'major', None, {}, 'flown in May'),
		('dataset_evaluation', 'image', 'minor', None, {'cog_issue': True}, 'check COG'),
		('georef', 'georef', 'ok', None, {}, None),
		# the prediction judged is the newest one made before the audit
		('prediction_quality', 'deadwood', 'minor', before, {}, 'misses snags'),
		('prediction_quality', 'forest_cover', 'major', None, {}, None),
	]
	assert after != before
	assert imported(db, excluded) == [('dataset_evaluation', 'image', 'major', None, {}, None)]
	assert imported(db, unattributed) == []
	assert db.execute(
		"SELECT DISTINCT assessor_user_id, details->>'source' FROM audit.assessments WHERE dataset_id=%s", (full,)
	).fetchall() == [(auditor, 'dataset_audit')]
	# a second run adds nothing
	assert audit_import.import_audits(db) == 0


def test_splits_keep_the_frozen_dataset_side_and_hash_the_rest():
	crops = [
		{'id': 'a', 'dataset_id': 1, 'split': 'tune'},
		{'id': 'b', 'dataset_id': 1, 'split': 'batch3'},
		{'id': 'c', 'dataset_id': 2, 'split': 'holdout'},
		{'id': 'd', 'dataset_id': 3, 'split': 'case'},
	]
	assert audit_import.member_splits(crops) == {
		'a': 'dev',
		'b': 'dev',
		'c': 'holdout',
		'd': audit_import.hash_split(3),
	}
	with pytest.raises(ValueError):
		audit_import.member_splits(crops + [{'id': 'e', 'dataset_id': 2, 'split': 'tune'}])


def test_the_hash_split_matches_the_database(db):
	for dataset in (1, 2, 5, 14747, 99991):
		assert db.execute('SELECT audit.benchmark_split(%s)', (dataset,)).fetchone()[0] == audit_import.hash_split(
			dataset
		)


def shifted(footprint, n):
	"""The same square moved east by n crop widths, so each crop has its own footprint."""
	ring = [[lon + n * 0.001, lat] for lon, lat in footprint['coordinates'][0]]
	return {'type': 'Polygon', 'coordinates': [ring]}


def gold_root(tmp_path, dataset):
	root = tmp_path / 'bench'
	(root / 'gold-crops' / str(dataset)).mkdir(parents=True)
	for name, color in (('raw.jpg', 'green'), ('deadwood-fill.png', 'blue'), ('forest_cover-fill.png', 'yellow')):
		Image.new('RGB', (64, 64), color).save(root / 'gold-crops' / str(dataset) / name)
	crops = [
		{
			'id': f'gold-{dataset}',
			'dataset_id': dataset,
			'view': 'deadwood',
			'mpp': 0.05,
			'prefix': f'gold-crops/{dataset}/',
			'source': 'gold crop',
			'split': 'holdout',
		},
		{
			'id': f'gold-{dataset}-2',
			'dataset_id': dataset,
			'view': 'random',
			'mpp': 0.05,
			'prefix': f'gold-crops/{dataset}/',
			'source': 'new batch',
			'split': 'batch3',
		},
	]
	(root / 'gold-test.json').write_text(json.dumps(crops))
	labels = sqlite3.connect(root / 'gold-labels.sqlite3')
	labels.execute('CREATE TABLE labels (crop_id TEXT PRIMARY KEY, payload TEXT, updated_at TEXT)')
	answers = {
		'm0_assessable': True,
		'm1_dead_missed': True,
		'm2_dw_on_live_vegetation': 'unsure',
		'm5_fc_trees_missed': False,
		'm8_dead_not_forest': True,
		'v_deadwood': 'major',
		'v_forest': 'ok',
	}
	labels.execute(
		'INSERT INTO labels VALUES (?,?,?)',
		(f'gold-{dataset}', json.dumps({'answers': answers, 'sizes': {}, 'note': 'snags missed'}), GRADED_AT),
	)
	labels.execute(
		'INSERT INTO labels VALUES (?,?,?)',
		(f'gold-{dataset}-2', json.dumps({'answers': {'m0_assessable': False}, 'sizes': {}, 'note': ''}), GRADED_AT),
	)
	labels.commit()
	labels.close()
	footprint = {
		'type': 'Polygon',
		'coordinates': [[[7.8, 48.0], [7.8005, 48.0], [7.8005, 48.0005], [7.8, 48.0005], [7.8, 48.0]]],
	}
	manifest = [
		{
			'gold_id': c['id'],
			'dataset_id': dataset,
			'footprint': shifted(footprint, n),
			'mpp': 0.05,
			'size_px': 1024,
			'label_ids': {'deadwood': 901, 'forest_cover': 902},
			'files': {
				'raw': f'gold-crops/{dataset}/raw.jpg',
				'deadwood_overlay': f'gold-crops/{dataset}/deadwood-fill.png',
				'forest_cover_overlay': f'gold-crops/{dataset}/forest_cover-fill.png',
			},
		}
		for n, c in enumerate(crops)
	]
	return root, manifest


def test_gold_crops_become_a_frozen_benchmark_of_truth_rows(db, tmp_path):
	grader = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	db.execute(
		'INSERT INTO public.v2_orthos(dataset_id,ortho_file_name,version,ortho_file_size,sha256,created_at) '
		"VALUES (%s,'o.tif',1,1,%s,'2026-01-01')",
		(dataset, SHA),
	)
	root, manifest = gold_root(tmp_path, dataset)
	plan, problems = audit_import.plan_gold(db, root, manifest, audit_import.load_labels(root / 'gold-labels.sqlite3'))
	assert problems == []
	summary = audit_import.summarize_gold(plan, problems)
	assert summary['crops'] == 2 and summary['splits'] == {'holdout': 2}

	benchmark = audit_import.import_gold(db, plan, str(grader))
	assert db.execute(
		'SELECT name,version,frozen_at IS NOT NULL FROM audit.benchmarks WHERE id=%s', (benchmark,)
	).fetchone() == (
		'pq-gold-dt1272',
		'v1',
		True,
	)
	assert db.execute(
		'SELECT split,count(*) FROM audit.benchmark_members WHERE benchmark_id=%s GROUP BY 1', (benchmark,)
	).fetchall() == [('holdout', 2)]
	assert db.execute(
		"SELECT count(*),bool_and(pixel_x0 IS NULL),bool_and(crop_sets='{benchmark}') FROM audit.crops WHERE dataset_id=%s",
		(dataset,),
	).fetchone() == (2, True, True)
	assert db.execute(
		"SELECT kind,label_id,storage_path LIKE 'audit/benchmarks/pq-gold-dt1272/%%' FROM audit.images "
		'WHERE dataset_id=%s ORDER BY kind,label_id LIMIT 3',
		(dataset,),
	).fetchall() == [
		('deadwood_overlay', 901, True),
		('deadwood_overlay', 901, True),
		('forest_cover_overlay', 902, True),
	]
	rows = db.execute(
		"SELECT c.selection->'benchmark'->>'gold_id',a.layer,a.verdict,a.modes,a.details->'unsure_modes',a.details->'legacy',"
		'a.imported_from,a.assessor_user_id FROM audit.assessments a JOIN audit.crops c ON c.id=a.crop_id '
		'WHERE a.dataset_id=%s ORDER BY 1,2',
		(dataset,),
	).fetchall()
	assert rows == [
		(
			f'gold-{dataset}',
			'deadwood',
			'major',
			{'m1_dead_missed': True},
			['m2_dw_on_live_vegetation'],
			None,
			None,
			grader,
		),
		(f'gold-{dataset}', 'forest_cover', 'ok', {}, None, {'m8_dead_not_forest': True}, None, grader),
		(f'gold-{dataset}', 'image', 'ok', {}, None, None, None, grader),
		(f'gold-{dataset}-2', 'image', 'major', {'m0_not_assessable': True}, None, None, None, grader),
	]
	with pytest.raises(SystemExit):
		audit_import.import_gold(db, plan, str(grader))


def test_gold_crops_on_a_replaced_ortho_or_without_a_footprint_are_left_out(db, tmp_path):
	dataset = create_dataset(db, create_user(db))
	db.execute(
		'INSERT INTO public.v2_orthos(dataset_id,ortho_file_name,version,ortho_file_size,sha256,created_at) '
		"VALUES (%s,'o.tif',1,1,%s,'2026-10-20')",
		(dataset, SHA),
	)
	root, manifest = gold_root(tmp_path, dataset)
	manifest[1]['footprint'] = None
	plan, problems = audit_import.plan_gold(db, root, manifest, audit_import.load_labels(root / 'gold-labels.sqlite3'))
	assert plan == []
	assert sorted(problems) == [
		f'gold-{dataset}-2: manifest lacks footprint',
		f'gold-{dataset}: the ortho was replaced after grading',
	]


def test_test_crops_get_their_footprint_from_the_cog_window(db, tmp_path):
	dataset = create_dataset(db, create_user(db))
	geo = {'CRS': 'EPSG:3857', 'Origin': [868_000.0, 6_100_000.0], 'Resolution': [0.05, -0.05]}
	db.execute(
		'INSERT INTO public.v2_cogs(dataset_id,cog_file_size,cog_file_name,version,cog_path,cog_info) '
		"VALUES (%s,1,'c.tif',1,'x/c.tif',%s)",
		(dataset, json.dumps({'GEO': geo})),
	)
	root = tmp_path / 'bench'
	(root / 'datasets' / str(dataset)).mkdir(parents=True)
	(root / 'datasets' / str(dataset) / 'evidence.json').write_text(
		json.dumps(
			{
				'cog': {'path': 'x/c.tif', 'version': 1},
				'label_ids': {'deadwood': 5, 'forest_cover': 6},
				'views': [{'name': 'n1', 'window': [200, 100, 1024, 1024], 'size': [1024, 1024]}],
			}
		)
	)
	crop = {
		'id': f'{dataset}-N1',
		'dataset_id': dataset,
		'view': 'n1',
		'mpp': 0.05,
		'prefix': f'datasets/{dataset}/n1-',
	}
	entries, problems = audit_import.test_crop_entries(db, root, [crop])
	assert problems == []
	ring = entries[0]['footprint']['coordinates'][0]
	lons, lats = [p[0] for p in ring], [p[1] for p in ring]
	# column 200, row 100, then 1024 px at 5 cm = 51.2 m on the 3857 grid
	expected = db.execute(
		'SELECT ST_XMin(g),ST_XMax(g),ST_YMin(g),ST_YMax(g) FROM '
		'(SELECT ST_Transform(ST_MakeEnvelope(868010,6099943.8,868061.2,6099995,3857),4326) g) e'
	).fetchone()
	assert (min(lons), max(lons), min(lats), max(lats)) == pytest.approx(expected)
	assert entries[0]['label_ids'] == {'deadwood': 5, 'forest_cover': 6}
	assert entries[0]['files']['raw'] == f'datasets/{dataset}/n1-raw.jpg'
