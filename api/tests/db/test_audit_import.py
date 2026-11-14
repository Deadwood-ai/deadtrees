"""Importing the saved audits and the DT-1272 gold crops into the audit schema (scripts/audit_import.py)."""

import hashlib
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


def gold_root(tmp_path, dataset, frozen='holdout'):
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
			'split': 'batch3',
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
	graded = {c['id'] for c in crops}
	# an earlier crop of the dataset that was never graded still fixes its split
	crops.append({**crops[0], 'id': f'gold-{dataset}-old', 'split': frozen})
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
			'ortho_sha256': SHA,
			'footprint': shifted(footprint, n),
			'mpp': 0.05,
			'size_px': 1024,
			'label_ids': {'deadwood': 901, 'forest_cover': 902},
			'files': {
				'raw': f'gold-crops/{dataset}/raw.jpg',
				'deadwood_overlay': f'gold-crops/{dataset}/deadwood-fill.png',
				'forest_cover_overlay': f'gold-crops/{dataset}/forest_cover-fill.png',
				# outlines are rendered too but are not an image kind of the schema
				'deadwood_outline': f'gold-crops/{dataset}/deadwood-fill.png',
			},
			'size_wh': [1024, 1000] if n else [1024, 1024],
		}
		for n, c in enumerate(crops)
		if c['id'] in graded
	]
	return root, manifest


def dataset_with_split(db, split):
	"""A dataset whose id hashes to the given side, to tell a frozen split from the hash."""
	dataset = next(i for i in range(9_000_000, 9_001_000) if audit_import.hash_split(i) == split)
	db.execute(
		"INSERT INTO public.v2_datasets(id,user_id,file_name,license,platform) VALUES (%s,%s,'g.tif','CC BY','drone')",
		(dataset, create_user(db)),
	)
	return dataset


def test_gold_crops_become_a_frozen_benchmark_of_truth_rows(db, tmp_path):
	grader = create_user(db, can_audit=True)
	dataset = dataset_with_split(db, 'dev')
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
		"SELECT count(*),bool_and(pixel_x0 IS NULL),bool_and(crop_sets='{benchmark}'),"
		"count(*) FILTER (WHERE selection->'benchmark'->'size_wh' = '[1024, 1000]') FROM audit.crops WHERE dataset_id=%s",
		(dataset,),
	).fetchone() == (2, True, True, 1)
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
	assert audit_import.benchmark_exists(db)

	# copies never replace stored evidence: the same file again is fine, another one is refused
	target = tmp_path / 'storage'
	audit_import.copy_images(plan, str(target))
	stored = target / 'audit/benchmarks/pq-gold-dt1272' / f'gold-{dataset}' / 'raw.jpg'
	before = stored.read_bytes()
	audit_import.copy_images(plan, str(target))
	Image.new('RGB', (64, 64), 'red').save(plan[0]['files']['raw'])
	with pytest.raises(SystemExit):
		audit_import.copy_images(plan, str(target))
	assert stored.read_bytes() == before


def test_gold_crops_on_a_replaced_ortho_or_without_a_footprint_are_left_out(db, tmp_path):
	dataset = create_dataset(db, create_user(db))
	# the ortho row kept its creation date when its content was replaced
	db.execute(
		'INSERT INTO public.v2_orthos(dataset_id,ortho_file_name,version,ortho_file_size,sha256,created_at) '
		"VALUES (%s,'o.tif',1,1,%s,'2026-01-01')",
		(dataset, 'd' * 64),
	)
	root, manifest = gold_root(tmp_path, dataset)
	manifest[1]['footprint'] = None
	plan, problems = audit_import.plan_gold(db, root, manifest, audit_import.load_labels(root / 'gold-labels.sqlite3'))
	assert plan == []
	assert sorted(problems) == [
		f'gold-{dataset}-2: manifest lacks footprint',
		f'gold-{dataset}: the ortho was replaced since the crop was cut',
	]


def gold_entry_twice(db, tmp_path, later_answers=None):
	"""One window graded twice: two manifest entries with the same footprint."""
	dataset = create_dataset(db, create_user(db))
	db.execute(
		'INSERT INTO public.v2_orthos(dataset_id,ortho_file_name,version,ortho_file_size,sha256) '
		"VALUES (%s,'o.tif',1,1,%s)",
		(dataset, SHA),
	)
	root, manifest = gold_root(tmp_path, dataset)
	manifest[1]['footprint'] = manifest[0]['footprint']
	labels = sqlite3.connect(root / 'gold-labels.sqlite3')
	first = json.loads(labels.execute('SELECT payload FROM labels WHERE crop_id=?', (f'gold-{dataset}',)).fetchone()[0])
	answers = {**first['answers'], **(later_answers or {})}
	labels.execute(
		'UPDATE labels SET payload=?, updated_at=? WHERE crop_id=?',
		(json.dumps({**first, 'answers': answers}), '2026-10-13T08:20:00+00:00', f'gold-{dataset}-2'),
	)
	labels.commit()
	labels.close()
	plan, problems = audit_import.plan_gold(db, root, manifest, audit_import.load_labels(root / 'gold-labels.sqlite3'))
	assert problems == []
	return dataset, plan


def test_a_window_graded_twice_alike_is_one_crop_with_both_gradings(db, tmp_path):
	grader = create_user(db, can_audit=True)
	dataset, plan = gold_entry_twice(db, tmp_path)
	summary = audit_import.summarize_gold(plan, [])
	assert (summary['graded_entries'], summary['crops'], summary['conflicts']) == (2, 1, [])
	assert summary['same_crop_graded_twice'] == [[f'gold-{dataset}', f'gold-{dataset}-2']]
	benchmark = audit_import.import_gold(db, plan, str(grader))
	assert db.execute('SELECT count(*) FROM audit.crops WHERE dataset_id=%s', (dataset,)).fetchone() == (1,)
	assert db.execute(
		'SELECT count(*) FROM audit.benchmark_members WHERE benchmark_id=%s', (benchmark,)
	).fetchone() == (1,)
	assert db.execute('SELECT count(*) FROM audit.images WHERE dataset_id=%s', (dataset,)).fetchone() == (3,)
	# both gradings are kept; for one person the later one is the latest answer
	assert db.execute(
		"SELECT count(*) FROM audit.assessments WHERE dataset_id=%s AND layer='deadwood'", (dataset,)
	).fetchone() == (2,)
	assert db.execute(
		"SELECT count(*) FROM audit.latest_assessments WHERE dataset_id=%s AND layer='deadwood'", (dataset,)
	).fetchone() == (1,)


def test_gradings_that_differ_are_reported_and_the_later_one_counts_when_accepted(db, tmp_path):
	grader = create_user(db, can_audit=True)
	dataset, plan = gold_entry_twice(db, tmp_path, later_answers={'v_forest': 'minor', 'm5_fc_trees_missed': True})
	found = audit_import.conflicts(plan)
	assert [(c['dataset_id'], c['layer']) for c in found] == [(dataset, 'forest_cover')]
	assert found[0]['answers'][f'gold-{dataset}']['verdict'] == 'ok'
	assert found[0]['answers'][f'gold-{dataset}-2']['verdict'] == 'minor'
	audit_import.import_gold(db, plan, str(grader))
	assert db.execute(
		"SELECT verdict::text FROM audit.latest_assessments WHERE dataset_id=%s AND layer='forest_cover'", (dataset,)
	).fetchall() == [('minor',)]
	assert db.execute(
		"SELECT count(*) FROM audit.assessments WHERE dataset_id=%s AND layer='forest_cover'", (dataset,)
	).fetchone() == (2,)


def test_a_crop_already_stored_with_that_footprint_is_reused(db, tmp_path):
	grader = create_user(db, can_audit=True)
	dataset, plan = gold_entry_twice(db, tmp_path)
	stored = db.execute(
		'INSERT INTO audit.crops(dataset_id,ortho_sha256,crop_sets,geometry,mpp,size_px,selection) '
		'VALUES (%s,%s,\'{evaluation}\',ST_SetSRID(ST_GeomFromGeoJSON(%s),4326),0.05,1024,\'{"evaluation": {"picker": "eval-v1"}}\') RETURNING id',
		(dataset, SHA, json.dumps(plan[0]['footprint'])),
	).fetchone()[0]
	audit_import.import_gold(db, plan, str(grader))
	row = db.execute(
		'SELECT id,crop_sets,selection ? %s,selection ? %s FROM audit.crops WHERE dataset_id=%s',
		('evaluation', 'benchmark', dataset),
	).fetchall()
	assert (
		len(row) == 1
		and row[0][0] == stored
		and sorted(row[0][1]) == ['benchmark', 'evaluation']
		and row[0][2:] == (True, True)
	)


def test_a_second_grading_on_another_prediction_keeps_its_overlays(db, tmp_path):
	grader = create_user(db, can_audit=True)
	dataset, plan = gold_entry_twice(db, tmp_path)
	later = next(i for i in plan if i['gold_id'].endswith('-2'))
	later['label_ids'] = {'deadwood': 911, 'forest_cover': 912}
	audit_import.import_gold(db, plan, str(grader))
	# one raw image, and both overlays for each of the two predictions
	assert db.execute(
		'SELECT kind,label_id FROM audit.images WHERE dataset_id=%s ORDER BY kind,label_id', (dataset,)
	).fetchall() == [
		('deadwood_overlay', 901),
		('deadwood_overlay', 911),
		('forest_cover_overlay', 902),
		('forest_cover_overlay', 912),
		('raw', None),
	]
	target = tmp_path / 'storage'
	audit_import.copy_images(plan, str(target))
	root = target / 'audit/benchmarks/pq-gold-dt1272'
	assert sorted(p.name for p in (root / f'gold-{dataset}').iterdir()) == [
		'deadwood-fill.png',
		'forest_cover-fill.png',
		'raw.jpg',
	]
	assert sorted(p.name for p in (root / f'gold-{dataset}-2').iterdir()) == [
		'deadwood-fill.png',
		'forest_cover-fill.png',
	]


def test_the_images_of_a_window_graded_twice_are_copied_once(db, tmp_path):
	dataset, plan = gold_entry_twice(db, tmp_path)
	target = tmp_path / 'storage'
	audit_import.copy_images(plan, str(target))
	stored = sorted(p.parent.name for p in (target / 'audit/benchmarks/pq-gold-dt1272').rglob('raw.jpg'))
	assert stored == [f'gold-{dataset}']


def test_test_crops_take_footprint_and_ortho_from_the_cog_when_the_pixels_match(db, tmp_path):
	import numpy as np
	import rasterio
	from rasterio.transform import from_origin

	dataset, moved = (create_dataset(db, create_user(db)) for _ in range(2))
	root, cogs = tmp_path / 'bench', tmp_path / 'cogs'
	(cogs / 'x').mkdir(parents=True)
	rng = np.random.default_rng(7)
	# structure at the scale of the comparison, as in an orthophoto, not pixel noise
	pixels = np.kron(rng.integers(0, 255, (3, 64, 64)), np.ones((1, 32, 32))).astype(np.uint8)
	profile = {
		'driver': 'GTiff',
		'width': 2048,
		'height': 2048,
		'count': 3,
		'dtype': 'uint8',
		'crs': 'EPSG:3857',
		'transform': from_origin(868_000.0, 6_100_000.0, 0.05, 0.05),
	}
	with rasterio.open(cogs / 'x' / 'c.tif', 'w', **profile) as dst:
		dst.write(pixels)
	window = [200, 100, 1024, 1024]  # column, row, width, height
	for ds in (dataset, moved):
		db.execute(
			"INSERT INTO public.v2_cogs(dataset_id,cog_file_size,cog_file_name,version,cog_path) VALUES (%s,1,'c.tif',1,'x/c.tif')",
			(ds,),
		)
		db.execute(
			"INSERT INTO public.v2_orthos(dataset_id,ortho_file_name,version,ortho_file_size,sha256) VALUES (%s,'o.tif',1,1,%s)",
			(ds, SHA),
		)
		(root / 'datasets' / str(ds)).mkdir(parents=True)
		(root / 'datasets' / str(ds) / 'evidence.json').write_text(
			json.dumps(
				{
					'cog': {'path': 'x/c.tif', 'version': 1},
					'label_ids': {'deadwood': 5, 'forest_cover': 6},
					'views': [{'name': 'n1', 'window': window, 'size': [1024, 1024]}],
				}
			)
		)
	cut = pixels[:, 100:1124, 200:1224].transpose(1, 2, 0)
	Image.fromarray(cut).save(root / 'datasets' / str(dataset) / 'n1-raw.jpg', quality=85)
	# a crop whose stored image shows another place no longer matches the ortho
	Image.fromarray(pixels[:, 900:1924, 900:1924].transpose(1, 2, 0)).save(
		root / 'datasets' / str(moved) / 'n1-raw.jpg'
	)
	crops = [
		{'id': f'{ds}-N1', 'dataset_id': ds, 'view': 'n1', 'mpp': 0.05, 'prefix': f'datasets/{ds}/n1-'}
		for ds in (dataset, moved)
	]
	entries, problems = audit_import.test_crop_entries(db, root, crops, cog_root=str(cogs))
	assert problems == [f'{moved}-N1: the stored image does not match the current ortho']
	(entry,) = entries
	assert entry['ortho_sha256'] == SHA and entry['label_ids'] == {'deadwood': 5, 'forest_cover': 6}
	ring = entry['footprint']['coordinates'][0]
	lons, lats = [p[0] for p in ring], [p[1] for p in ring]
	# column 200, row 100, then 1024 px at 5 cm = 51.2 m on the 3857 grid
	expected = db.execute(
		'SELECT ST_XMin(g),ST_XMax(g),ST_YMin(g),ST_YMax(g) FROM '
		'(SELECT ST_Transform(ST_MakeEnvelope(868010,6099943.8,868061.2,6099995,3857),4326) g) e'
	).fetchone()
	assert (min(lons), max(lons), min(lats), max(lats)) == pytest.approx(expected)
	assert entry['files']['raw'] == f'datasets/{dataset}/n1-raw.jpg'


def test_remote_copies_stop_on_a_conflicting_stored_image(tmp_path):
	raw = tmp_path / 'raw.jpg'
	Image.new('RGB', (8, 8), 'green').save(raw)
	digest = hashlib.sha256(raw.read_bytes()).hexdigest()
	plan = [{'gold_id': 'gold-1', 'label_ids': {}, 'files': {'raw': raw}}]
	destination = 'storage:/data/audit/benchmarks/pq-gold-dt1272/gold-1/raw.jpg'
	calls = []

	def remote(returncode, stdout='', stderr=''):
		def run(command, **kwargs):
			calls.append(command)
			return type('Done', (), {'returncode': returncode, 'stdout': stdout, 'stderr': stderr})()

		return run

	# the same file is already stored: nothing is copied
	audit_import.copy_images(plan, 'storage:/data', run=remote(0, f'{digest}  /data/x\n'))
	assert [c[0] for c in calls] == ['ssh'] and calls[0][-1] == '/data/audit/benchmarks/pq-gold-dt1272/gold-1/raw.jpg'
	# a new file is copied
	calls.clear()
	audit_import.copy_images(plan, 'storage:/data', run=remote(1, stderr='sha256sum: x: No such file or directory'))
	assert [c[0] for c in calls] == ['ssh', 'rsync'] and calls[1][-1] == destination
	# another file under that name, or a failed check, stops before anything is written
	for run in (remote(0, f'{"0" * 64}  /data/x\n'), remote(255, stderr='ssh: connect to host storage: refused')):
		calls.clear()
		with pytest.raises(SystemExit):
			audit_import.copy_images(plan, 'storage:/data', run=run)
		assert [c[0] for c in calls] == ['ssh']


def test_picked_evaluation_datasets_join_the_open_gold_set_once(db):
	owner = create_user(db)
	kept, excluded = create_dataset(db, owner), create_dataset(db, owner)
	deleted = excluded + 10_000_000
	gold = {
		'datasets': [
			{'dataset_id': kept, 'split': audit_import.hash_split(kept)},
			{'dataset_id': excluded, 'split': audit_import.hash_split(excluded)},
			{'dataset_id': deleted, 'split': audit_import.hash_split(deleted)},
		]
	}
	plan = audit_import.plan_evaluation_gold(db, gold)
	assert (plan['picked'], plan['deleted_since'], plan['already_members'], plan['to_add']) == (3, [deleted], 0, 2)
	assert plan['split_differs'] == [] and sum(plan['splits'].values()) == 2
	assert audit_import.import_evaluation_gold(db, plan) == 2
	assert db.execute(
		'SELECT dataset_id, crop_id, split FROM audit.benchmark_members WHERE benchmark_id=%s ORDER BY dataset_id',
		(plan['benchmark_id'],),
	).fetchall() == [(d, None, audit_import.hash_split(d)) for d in (kept, excluded)]
	again = audit_import.plan_evaluation_gold(db, gold)
	assert (again['already_members'], again['to_add']) == (2, 0)
