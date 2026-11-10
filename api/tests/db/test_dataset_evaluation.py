"""Dataset evaluation check: the store function, perceptual hashes and duplicate candidates."""

import json

import psycopg
import pytest

from api.tests.db.test_acquisition_date_estimates import (  # noqa: F401
	PROCESSOR_EMAIL,
	act_as,
	as_admin,
	create_dataset,
	create_user,
	db,
	processor_user,
)
from api.tests.db.test_audit_checks import as_worker, register_version

SHA = 'c' * 64
SQUARE = {
	'type': 'Polygon',
	'coordinates': [[[7.8, 48.0], [7.8003, 48.0], [7.8003, 48.0003], [7.8, 48.0003], [7.8, 48.0]]],
}


def add_ortho(db, dataset, sha=SHA, box='BOX(7.80 48.00,7.81 48.01)'):
	as_admin(db)
	db.execute(
		'INSERT INTO public.v2_orthos (dataset_id,ortho_file_name,version,ortho_file_size,bbox,sha256,ortho_upload_runtime) '
		"VALUES (%s,'o.tif',1,1,%s,%s,0.1)",
		(dataset, box, sha),
	)


def queued_run(db, dataset, version_id, queue='upload'):
	as_worker(db)
	run = db.execute(
		'INSERT INTO audit.runs(check_key,check_version_id,dataset_id,queue,status,started_at) '
		"VALUES ('dataset_evaluation',%s,%s,%s,'running',now()) RETURNING id",
		(version_id, dataset, queue),
	).fetchone()[0]
	as_admin(db)
	return run


def call(model, verdict, likelihood, kind='model', version='v1'):
	return {
		'assessor_kind': kind,
		'model': model,
		'prompt_version': version,
		'verdict': verdict,
		'major_likelihood': likelihood,
		'modes': {'blurry': {'likelihood': likelihood}},
		'details': {'reason': 'blurry' if verdict == 'major' else None, 'summary': 'A forest.'},
		'raw': {'text': '{}'} if kind == 'model' else None,
	}


def result(sha=SHA, phash=1234, crops=2):
	shift = lambda i: {'type': 'Polygon', 'coordinates': [[[x + i * 0.001, y] for x, y in SQUARE['coordinates'][0]]]}
	return {
		'ortho_sha256': sha,
		'inputs': {'ortho_sha256': sha, 'aoi': None, 'overview_px': 2048, 'crop_px': 1024, 'crop_count': crops},
		'evidence': {'native_mpp': 0.03},
		'coverage': {'crops': crops},
		'cost': {'haiku-5.5': {'input_tokens': 9000}},
		'crops': [
			{'geometry': shift(i), 'mpp': 0.03, 'size_px': 1024, 'selection': {'picker': 'spread-v1', 'index': i + 1}}
			for i in range(crops)
		],
		'images': [
			{
				'kind': 'overview',
				'crop_index': None,
				'storage_path': f'audit/dataset_evaluation/1/{sha[:16]}/overview-{"d" * 16}.jpg',
				'content_type': 'image/jpeg',
				'width': 2048,
				'height': 1500,
				'mpp': 0.3,
				'bytes': 900000,
				'sha256': 'd' * 64,
			}
		]
		+ [
			{
				'kind': 'raw',
				'crop_index': i + 1,
				'storage_path': f'audit/dataset_evaluation/1/{sha[:16]}/crop-{i + 1:016d}.jpg',
				'content_type': 'image/jpeg',
				'width': 1024,
				'height': 1024,
				'mpp': 0.03,
				'bytes': 300000,
				'sha256': 'e' * 64,
			}
			for i in range(crops)
		],
		'assessments': [
			call('luna-medium', 'major', 80),
			call('haiku-5.5', 'major', 70),
			# the one rule row: band check and duplicates are folded in and kept as run evidence
			call('dataset-evaluation-rule', 'major', 75, 'rule'),
		],
		'phash': {'method': 'phash-dct64-v1', 'value': phash},
	}


def store(db, run, payload):
	"""Store a run's result as the worker; returns the ids of the crops it judged."""
	as_worker(db)
	crop_ids = db.execute('SELECT audit.store_dataset_evaluation(%s,%s)', (run, json.dumps(payload))).fetchone()[0]
	as_admin(db)
	return crop_ids


@pytest.fixture
def evaluation(db):
	owner = create_user(db)
	dataset = create_dataset(db, owner)
	add_ortho(db, dataset)
	version = register_version(db, 'dataset_evaluation', 'v1-test')
	# only an active version's run becomes the dataset's current run (the current-run guard)
	db.execute("UPDATE audit.check_versions SET is_active=false WHERE check_key='dataset_evaluation'")
	db.execute('UPDATE audit.check_versions SET is_active=true WHERE id=%s', (version,))
	return owner, dataset, version


def finish(db, run, dataset):
	"""What the audit worker does after the handler: run done, dataset pointed at it."""
	as_worker(db)
	db.execute("UPDATE audit.runs SET status='done', finished_at=now() WHERE id=%s", (run,))
	db.execute(
		"INSERT INTO audit.current_runs(dataset_id,check_key,run_id) VALUES (%s,'dataset_evaluation',%s) "
		'ON CONFLICT (dataset_id,check_key) DO UPDATE SET run_id=excluded.run_id',
		(dataset, run),
	)
	as_admin(db)


def test_a_stored_run_lands_whole_and_leaves_the_lifecycle_to_the_worker(db, evaluation):
	_, dataset, version = evaluation
	run = queued_run(db, dataset, version)
	store(db, run, result())

	assert db.execute('SELECT status FROM audit.runs WHERE id=%s', (run,)).fetchone()[0] == 'running'
	assert db.execute('SELECT count(*) FROM audit.current_runs WHERE dataset_id=%s', (dataset,)).fetchone()[0] == 0
	rows = db.execute(
		'SELECT assessor, verdict, layer, crop_id FROM audit.assessments WHERE run_id=%s ORDER BY id', (run,)
	).fetchall()
	assert [r[0] for r in rows] == ['luna-medium/v1', 'haiku-5.5/v1', 'dataset-evaluation-rule/v1']
	assert {r[2] for r in rows} == {'image'} and all(r[3] is None for r in rows)
	images = db.execute(
		'SELECT kind, crop_id IS NULL FROM audit.images WHERE dataset_id=%s ORDER BY id', (dataset,)
	).fetchall()
	assert images == [('overview', True), ('raw', False), ('raw', False)]
	assert (
		db.execute('SELECT crop_sets FROM audit.crops WHERE dataset_id=%s', (dataset,)).fetchall()
		== [(['evaluation'],)] * 2
	)
	assert db.execute('SELECT hash FROM audit.image_hashes WHERE dataset_id=%s', (dataset,)).fetchone()[0] == 1234
	finish(db, run, dataset)
	# The review queue reads the rule rows: the dataset rule excludes, so a person reviews it.
	queue = db.execute(
		"SELECT verdict, needs_review FROM audit.review_queue WHERE dataset_id=%s AND check_key='dataset_evaluation'",
		(dataset,),
	).fetchone()
	assert queue == ('major', True)


def test_a_rerun_on_the_same_ortho_reuses_its_crops_and_images(db, evaluation):
	_, dataset, version = evaluation
	first = queued_run(db, dataset, version)
	store(db, first, result())
	finish(db, first, dataset)
	second = queued_run(db, dataset, version)
	# the run is told which crops it judged, in the order it sent them: here the stored ones again
	stored = [
		r[0] for r in db.execute('SELECT id FROM audit.crops WHERE dataset_id=%s ORDER BY id', (dataset,)).fetchall()
	]
	assert store(db, second, result()) == stored

	assert db.execute('SELECT count(*) FROM audit.crops WHERE dataset_id=%s', (dataset,)).fetchone()[0] == 2
	assert db.execute('SELECT count(*) FROM audit.images WHERE dataset_id=%s', (dataset,)).fetchone()[0] == 3
	assert db.execute('SELECT count(*) FROM audit.assessments WHERE dataset_id=%s', (dataset,)).fetchone()[0] == 6


def test_a_finished_run_or_another_check_is_refused_and_nothing_lands(db, evaluation):
	_, dataset, version = evaluation
	run = queued_run(db, dataset, version)
	store(db, run, result())
	finish(db, run, dataset)
	db.execute('SAVEPOINT again')
	with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState):
		store(db, run, result())
	db.execute('ROLLBACK TO SAVEPOINT again')

	other = register_version(db, 'georef', 'v1-test')
	as_worker(db)
	georef = db.execute(
		"INSERT INTO audit.runs(check_key,check_version_id,dataset_id,queue) VALUES ('georef',%s,%s,'upload') "
		'RETURNING id',
		(other, dataset),
	).fetchone()[0]
	db.execute('SAVEPOINT wrong')
	with pytest.raises(psycopg.errors.InvalidParameterValue):
		db.execute('SELECT audit.store_dataset_evaluation(%s,%s)', (georef, json.dumps(result())))
	db.execute('ROLLBACK TO SAVEPOINT wrong')
	as_admin(db)


def test_a_bad_row_rolls_back_the_whole_run(db, evaluation):
	_, dataset, version = evaluation
	run = queued_run(db, dataset, version)
	broken = result()
	broken['assessments'][1]['verdict'] = 'maybe'
	db.execute('SAVEPOINT broken')
	with pytest.raises(psycopg.errors.InvalidTextRepresentation):
		store(db, run, broken)
	db.execute('ROLLBACK TO SAVEPOINT broken')
	as_admin(db)

	assert db.execute('SELECT status FROM audit.runs WHERE id=%s', (run,)).fetchone()[0] == 'running'
	assert db.execute('SELECT count(*) FROM audit.crops WHERE dataset_id=%s', (dataset,)).fetchone()[0] == 0


def test_only_the_audit_worker_stores_runs(db, evaluation):
	owner, dataset, version = evaluation
	run = queued_run(db, dataset, version)
	auditor = create_user(db, can_audit=True)
	for user in (owner, auditor):
		act_as(db, user)
		db.execute('SAVEPOINT nope')
		# Auditors can see the run but have no write policy; owners cannot even see it.
		with pytest.raises((psycopg.errors.InsufficientPrivilege, psycopg.errors.NoDataFound)):
			db.execute('SELECT audit.store_dataset_evaluation(%s,%s)', (run, json.dumps(result())))
		db.execute('ROLLBACK TO SAVEPOINT nope')
	as_admin(db)
	assert db.execute('SELECT status FROM audit.runs WHERE id=%s', (run,)).fetchone()[0] == 'running'


def test_duplicate_candidates_find_copies_re_exports_and_same_day_flights(db, evaluation):
	owner, dataset, version = evaluation
	other_user = create_user(db)
	copy = create_dataset(db, other_user)
	add_ortho(db, copy, sha=SHA)  # the same file uploaded by someone else
	reexport = create_dataset(db, other_user, date=(2023, 5, 1))
	add_ortho(db, reexport, sha='1' * 64, box='BOX(7.801 48.001,7.811 48.011)')
	same_day = create_dataset(db, owner)
	add_ortho(db, same_day, sha='2' * 64, box='BOX(7.802 48.000,7.812 48.010)')
	elsewhere = create_dataset(db, owner)
	add_ortho(db, elsewhere, sha='3' * 64, box='BOX(9.0 50.0,9.01 50.01)')
	far_hash = create_dataset(db, other_user)
	add_ortho(db, far_hash, sha='4' * 64, box='BOX(7.80 48.00,7.81 48.01)')
	# an archived copy is a resolved duplicate, not a candidate
	archived = create_dataset(db, other_user)
	add_ortho(db, archived, sha=SHA)
	as_admin(db)
	db.execute('UPDATE public.v2_datasets SET archived=true WHERE id=%s', (archived,))
	for d, sha, value in ((reexport, '1' * 64, 0b1011), (far_hash, '4' * 64, -1)):
		db.execute(
			"INSERT INTO audit.image_hashes(dataset_id,ortho_sha256,method,hash) VALUES (%s,%s,'phash-dct64-v1',%s)",
			(d, sha, value),
		)

	as_worker(db)
	rows = db.execute(
		'SELECT dataset_id, kind, hamming, overlap FROM audit.duplicate_candidates(%s,%s)', (dataset, 0b1001)
	).fetchall()
	as_admin(db)
	found = {r[0]: r[1] for r in rows}
	assert found == {copy: 'same_file', reexport: 'same_image', same_day: 'same_flight_day'}
	assert [r[1] for r in rows] == ['same_file', 'same_image', 'same_flight_day']
	assert dict((r[0], r[2]) for r in rows)[reexport] == 1
	assert 0.75 < dict((r[0], r[3]) for r in rows)[reexport] < 0.85


def test_image_hashes_are_written_only_by_the_worker(db, evaluation):
	owner, dataset, _ = evaluation
	act_as(db, owner)
	db.execute('SAVEPOINT nope')
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute(
			"INSERT INTO audit.image_hashes(dataset_id,ortho_sha256,method,hash) VALUES (%s,%s,'phash-dct64-v1',1)",
			(dataset, SHA),
		)
	db.execute('ROLLBACK TO SAVEPOINT nope')
	as_admin(db)


def test_the_migration_can_be_reverted_without_touching_the_base(db):
	from api.tests.db.test_audit_checks import LATER_CHECKS_DOWN

	db.execute(LATER_CHECKS_DOWN)
	assert db.execute(
		"SELECT to_regclass('audit.image_hashes'), to_regprocedure('audit.store_dataset_evaluation(bigint,jsonb)')"
	).fetchone() == (None, None)
	assert db.execute("SELECT to_regclass('audit.runs') IS NOT NULL").fetchone() == (True,)


def test_a_crop_on_the_clip_grid_joins_the_crop_another_check_stored(db, evaluation):
	_, dataset, version = evaluation
	as_worker(db)
	existing = db.execute(
		'INSERT INTO audit.crops(dataset_id,ortho_sha256,crop_sets,pixel_x0,pixel_y0,pixel_x1,pixel_y1,geometry,mpp,size_px,selection) '
		"VALUES (%s,%s,'{exclude}',512,0,1024,512,'SRID=4326;POLYGON((7.8 48,7.8007 48,7.8007 48.0005,7.8 48.0005,7.8 48))',"
		'0.05,1024,%s) RETURNING id',
		(dataset, SHA, json.dumps({'exclude': {'picker': 'top-cover-v1'}})),
	).fetchone()[0]
	as_admin(db)
	payload = result(crops=2)
	payload['crops'][0]['pixel_window'] = [512, 0, 1024, 512]
	payload['crops'][0]['selection']['picker'] = 'clip-grid-kmeans-v1'
	run = queued_run(db, dataset, version)
	store(db, run, payload)

	rows = db.execute(
		'SELECT id, crop_sets, selection ? %s, pixel_x0 FROM audit.crops WHERE dataset_id=%s ORDER BY id',
		('exclude', dataset),
	).fetchall()
	assert rows[0] == (existing, ['evaluation', 'exclude'], True, 512)
	assert len(rows) == 2 and rows[1][3] is None  # the second crop stays off the grid
	assert (
		db.execute("SELECT count(*) FROM audit.images WHERE crop_id=%s AND kind='raw'", (existing,)).fetchone()[0] == 1
	)


def test_a_decided_verdict_is_one_rule_row_and_not_a_disagreement(db, evaluation):
	"""The queue reads every dataset-level rule row as a verdict. With the band check and
	the duplicates as rows of their own, every verdict but ok looked like a disagreement
	and could never leave review."""
	_, dataset, version = evaluation
	run = queued_run(db, dataset, version)
	store(db, run, result())
	finish(db, run, dataset)
	db.execute("UPDATE audit.check_versions SET mode='review_uncertain' WHERE id=%s", (version,))

	assert db.execute(
		"SELECT verdict::text, reason, needs_review FROM audit.review_queue WHERE dataset_id=%s AND check_key='dataset_evaluation'",
		(dataset,),
	).fetchall() == [('major', None, False)]


def test_an_empty_cog_stores_one_rule_row_that_sends_the_exclusion_to_review(db, evaluation):
	_, dataset, version = evaluation
	run = queued_run(db, dataset, version)
	empty = {
		'ortho_sha256': SHA,
		'crops': [],
		'images': [result()['images'][0]],
		'assessments': [
			{
				**call('empty_cog', 'major', 100, 'rule'),
				'modes': {'broken_ortho': {'likelihood': 100}},
				'details': {'reason': 'broken_ortho', 'valid_share': 0.0},
			}
		],
	}
	store(db, run, empty)
	finish(db, run, dataset)

	assert db.execute('SELECT assessor FROM audit.assessments WHERE run_id=%s', (run,)).fetchall() == [
		('empty_cog/v1',)
	]
	assert db.execute('SELECT count(*) FROM audit.image_hashes WHERE dataset_id=%s', (dataset,)).fetchone()[0] == 0
	queue = db.execute(
		"SELECT verdict, needs_review FROM audit.review_queue WHERE dataset_id=%s AND check_key='dataset_evaluation'",
		(dataset,),
	).fetchone()
	assert queue == ('major', True)
