"""Open benchmark versions: operators add targets, auditors label them, truth carries over between versions."""

from pathlib import Path

import psycopg
import pytest

from api.tests.db.test_acquisition_date_estimates import act_as, as_admin, create_dataset, create_user, db  # noqa: F401
from api.tests.db.test_audit_checks import create_crop, create_off_grid_crop, create_operator, person_row

MIGRATION = Path(__file__).parents[3] / 'supabase' / 'migrations' / '20261113150000_open_benchmark_versions.sql'


def other_side(db, dataset):
	"""The split the hash does not give the dataset, as a frozen set may have it."""
	hashed = db.execute('SELECT audit.benchmark_split(%s)', (dataset,)).fetchone()[0]
	return 'dev' if hashed == 'holdout' else 'holdout'


def benchmark(db, check='prediction_quality', name='pq-gold-dt1272', version='v1'):
	as_admin(db)
	return db.execute(
		'INSERT INTO audit.benchmarks(check_key,name,version) VALUES (%s,%s,%s) RETURNING id', (check, name, version)
	).fetchone()[0]


def freeze(db, benchmark_id):
	as_admin(db)
	db.execute('UPDATE audit.benchmarks SET frozen_at=now() WHERE id=%s', (benchmark_id,))


def member(db, benchmark_id, dataset, crop=None, split=None):
	as_admin(db)
	db.execute(
		'INSERT INTO audit.benchmark_members(benchmark_id,dataset_id,crop_id,split) VALUES (%s,%s,%s,%s)',
		(benchmark_id, dataset, crop, split),
	)


def add(db, user, dataset, crop=None, check='prediction_quality'):
	act_as(db, user)
	row = db.execute(
		'SELECT benchmark_id, dataset_id, crop_id, split, id FROM audit.add_benchmark_target(%s,%s,%s)',
		(check, dataset, crop),
	).fetchone()
	as_admin(db)
	return row


def test_operators_add_a_crop_to_the_open_version_on_its_datasets_side(db):
	operator, owner = create_operator(db), create_user(db)
	known, new = create_dataset(db, owner), create_dataset(db, owner)
	frozen_side = other_side(db, known)
	v1 = benchmark(db)
	member(db, v1, known, create_off_grid_crop(db, known), frozen_side)
	freeze(db, v1)
	v2 = benchmark(db, version='v2')

	crop, fresh = create_crop(db, known), create_crop(db, new)
	# the dataset keeps the side the frozen set gave it, a new dataset gets the hash
	assert add(db, operator, known, crop)[:4] == (v2, known, crop, frozen_side)
	hashed = db.execute('SELECT audit.benchmark_split(%s)', (new,)).fetchone()[0]
	assert add(db, operator, new, fresh)[:4] == (v2, new, fresh, hashed)
	assert db.execute('SELECT crop_sets FROM audit.crops WHERE id=%s', (crop,)).fetchone() == (
		['exclude', 'benchmark'],
	)
	# adding it again changes nothing and returns the same member
	first = db.execute('SELECT id FROM audit.benchmark_members WHERE crop_id=%s', (crop,)).fetchone()[0]
	assert add(db, operator, known, crop)[4] == first
	assert db.execute('SELECT count(*) FROM audit.benchmark_members WHERE benchmark_id=%s', (v2,)).fetchone() == (2,)
	assert db.execute('SELECT crop_sets FROM audit.crops WHERE id=%s', (crop,)).fetchone() == (
		['exclude', 'benchmark'],
	)


def test_only_operators_add_and_only_to_an_open_version_of_matching_targets(db):
	operator, auditor, owner = create_operator(db), create_user(db, can_audit=True), create_user(db)
	dataset = create_dataset(db, owner)
	crop = create_crop(db, dataset)
	with pytest.raises(psycopg.errors.NoDataFound), db.transaction():
		add(db, operator, dataset, crop)
	benchmark(db)
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		add(db, auditor, dataset, crop)
	add(db, operator, dataset, crop)
	# a crop benchmark takes no whole datasets
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		add(db, operator, dataset)
	# a crop belongs to its own dataset
	with pytest.raises(psycopg.errors.ForeignKeyViolation), db.transaction():
		add(db, operator, create_dataset(db, owner), crop)
	# one open version per check: the next one waits until this one is frozen
	with pytest.raises(psycopg.errors.UniqueViolation), db.transaction():
		benchmark(db, version='v2')


def test_datasets_join_the_open_dataset_evaluation_gold_set(db):
	operator = create_operator(db)
	dataset = create_dataset(db, create_user(db))
	gold = db.execute(
		"SELECT id FROM audit.benchmarks WHERE name='dataset-evaluation-gold' AND version='v1' AND frozen_at IS NULL"
	).fetchone()[0]
	hashed = db.execute('SELECT audit.benchmark_split(%s)', (dataset,)).fetchone()[0]
	assert add(db, operator, dataset, check='dataset_evaluation')[:4] == (gold, dataset, None, hashed)


def test_auditors_label_benchmark_crops_without_a_run_and_operators_alone_cannot(db):
	auditor, operator, owner = create_user(db, can_audit=True), create_operator(db), create_user(db)
	dataset = create_dataset(db, owner)
	crop = create_crop(db, dataset)
	benchmark(db)
	add(db, operator, dataset, crop)
	person_row(db, auditor, dataset, crop, 'major')
	assert db.execute(
		'SELECT verdict, run_id, imported_from FROM audit.latest_assessments WHERE crop_id=%s AND assessor_user_id=%s',
		(crop, auditor),
	).fetchone() == ('major', None, None)
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		person_row(db, operator, dataset, crop, 'ok')


def seed_block():
	"""The migration's v2 statement, run again on a database that has a v1."""
	text = MIGRATION.read_text()
	return text[text.index('with v1 as') : text.index('-- The dataset evaluation')]


def test_v2_opens_with_v1s_crops_splits_and_truth(db):
	auditor, owner = create_user(db, can_audit=True), create_user(db)
	datasets = [create_dataset(db, owner) for _ in range(2)]
	crops = [create_off_grid_crop(db, d) for d in datasets]
	v1 = benchmark(db)
	for dataset, crop in zip(datasets, crops):
		member(db, v1, dataset, crop, other_side(db, dataset))
		person_row(db, auditor, dataset, crop, 'minor')
	freeze(db, v1)
	db.execute(seed_block())
	v2, frozen = db.execute(
		"SELECT id, frozen_at FROM audit.benchmarks WHERE name='pq-gold-dt1272' AND version='v2'"
	).fetchone()
	assert frozen is None

	def members(b):
		return db.execute(
			'SELECT dataset_id, crop_id, split FROM audit.benchmark_members WHERE benchmark_id=%s ORDER BY crop_id',
			(b,),
		).fetchall()

	assert members(v2) == members(v1) and len(members(v2)) == 2
	# truth is keyed by target, so the v1 answers are v2's truth too
	assert db.execute(
		'SELECT count(*) FROM audit.benchmark_members m JOIN audit.latest_assessments a ON a.crop_id = m.crop_id '
		"WHERE m.benchmark_id=%s AND a.assessor_kind='person' AND a.imported_from IS NULL",
		(v2,),
	).fetchone() == (2,)
	# a second run adds nothing
	db.execute(seed_block())
	assert len(members(v2)) == 2
