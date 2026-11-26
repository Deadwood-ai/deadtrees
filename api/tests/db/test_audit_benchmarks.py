"""Benchmarks are the in_benchmark tick on a person's review: operators draw random targets
(audit.draw_target), label them with a plain insert and take them out again
(audit.remove_benchmark_target). See docs/audit-checks.md, Benchmarks."""

import psycopg

from api.tests.db.test_acquisition_date_estimates import act_as, as_admin, create_dataset, create_user, db  # noqa: F401
from api.tests.db.test_audit_checks import (
	add_labels,
	create_operator,
	create_run,
	dataset_judgement,
	finish,
	pq_run,
	raises,
	register_version,
	tile_ids,
	tile_judgement,
)


def draw(db, user, benchmark, skipped=()):
	act_as(db, user)
	rows = db.execute('SELECT dataset_id, tile_id FROM audit.draw_target(%s,%s)', (benchmark, list(skipped))).fetchall()
	as_admin(db)
	return rows


def label_tile(db, operator, dataset, tile_id, label, layer='deadwood', verdict='minor'):
	act_as(db, operator)
	db.execute(
		'INSERT INTO audit.tile_human_reviews(dataset_id,tile_id,layer,prediction_label_id,verdict,in_benchmark) '
		'VALUES (%s,%s,%s,%s,%s,true)',
		(dataset, tile_id, layer, label, verdict),
	)
	as_admin(db)


def label_dataset(db, operator, dataset, decision='keep'):
	act_as(db, operator)
	db.execute(
		"INSERT INTO audit.dataset_human_reviews(dataset_id,check_key,decision,in_benchmark) VALUES (%s,'dataset_evaluation',%s,true)",
		(dataset, decision),
	)
	as_admin(db)


def only(db, datasets, check):
	"""Keep the draw to these datasets: every other dataset's current run of the check goes."""
	as_admin(db)
	db.execute('DELETE FROM audit.runs WHERE check_key=%s AND NOT dataset_id = ANY(%s)', (check, list(datasets)))


def test_a_tile_benchmark_draws_unticked_tiles_with_a_call_on_its_layer(db):
	operator, owner = create_operator(db), create_user(db)
	dataset, excluded = create_dataset(db, owner), create_dataset(db, owner)
	labels = add_labels(db, dataset)
	version = register_version(db, version='pq-draw')
	run = pq_run(
		db,
		dataset,
		version,
		labels,
		[
			tile_judgement(1, 'deadwood', 'haiku-5.5', 'ok'),
			tile_judgement(2, 'deadwood', 'haiku-5.5', 'major'),
			tile_judgement(3, 'deadwood', 'haiku-5.5', 'not_assessable'),  # no call
			tile_judgement(3, 'forest_cover', 'haiku-5.5', 'ok'),
		],
	)
	pq_run(db, excluded, version, add_labels(db, excluded), [tile_judgement(1, 'deadwood', 'haiku-5.5', 'ok')])
	db.execute("INSERT INTO audit.legacy_decisions(dataset_id,decision,decided_at) VALUES (%s,'exclude',now())", (excluded,))
	only(db, (dataset, excluded), 'prediction_quality')
	first, second, third = tile_ids(db, run)

	assert {draw(db, operator, 'deadwood')[0] for _ in range(10)} <= {(dataset, first), (dataset, second)}
	assert draw(db, operator, 'deadwood', [first]) == [(dataset, second)]
	assert draw(db, operator, 'forest_cover') == [(dataset, third)]
	# a labeled target is ticked and not drawn again; when nothing is left there is no row
	label_tile(db, operator, dataset, second, labels['deadwood'])
	assert draw(db, operator, 'deadwood', [first]) == []
	# taking it out again clears the tick; the label stays a review of the tile
	act_as(db, operator)
	assert db.execute('SELECT audit.remove_benchmark_target(%s,%s,%s)', ('deadwood', dataset, second)).fetchone() == (1,)
	as_admin(db)
	assert db.execute(
		'SELECT verdict::text, in_benchmark FROM audit.tile_human_reviews WHERE tile_id=%s', (second,)
	).fetchall() == [('minor', False)]
	assert draw(db, operator, 'deadwood', [first]) == [(dataset, second)]


def test_the_dataset_benchmark_draws_datasets_with_a_current_evaluation(db):
	operator, owner = create_operator(db), create_user(db)
	first, second, unevaluated = (create_dataset(db, owner) for _ in range(3))
	version = register_version(db, 'dataset_evaluation', 'de-draw')
	for dataset in (first, second):
		finish(
			db,
			create_run(db, dataset, version, check='dataset_evaluation'),
			dataset_judgements=[dataset_judgement('haiku-5.5', 'ok')],
		)
	only(db, (first, second), 'dataset_evaluation')
	assert {draw(db, operator, 'dataset_evaluation')[0] for _ in range(10)} <= {(first, None), (second, None)}
	assert draw(db, operator, 'dataset_evaluation', [first]) == [(second, None)]
	# the operator's label is also the dataset's review
	label_dataset(db, operator, second, 'exclude')
	assert draw(db, operator, 'dataset_evaluation', [first]) == []
	assert db.execute('SELECT decision::text, source FROM audit.evaluation_decisions WHERE dataset_id=%s', (second,)).fetchone() == (
		'exclude',
		'reviewer',
	)
	act_as(db, operator)
	assert db.execute('SELECT audit.remove_benchmark_target(%s,%s)', ('dataset_evaluation', second)).fetchone() == (1,)
	assert db.execute('SELECT audit.remove_benchmark_target(%s,%s)', ('dataset_evaluation', unevaluated)).fetchone() == (0,)
	as_admin(db)
	assert db.execute(
		'SELECT decision::text, in_benchmark FROM audit.current_dataset_human_reviews WHERE dataset_id=%s', (second,)
	).fetchone() == ('exclude', False)


def test_only_operators_draw_and_remove_targets(db):
	auditor, operator, dataset = create_user(db, can_audit=True), create_operator(db), create_dataset(db, create_user(db))
	act_as(db, auditor)
	raises(db, psycopg.errors.InsufficientPrivilege, "SELECT * FROM audit.draw_target('deadwood','{}')")
	raises(db, psycopg.errors.InsufficientPrivilege, "SELECT audit.remove_benchmark_target('dataset_evaluation',%s)", (dataset,))
	act_as(db, operator)
	raises(db, psycopg.errors.InvalidParameterValue, "SELECT * FROM audit.draw_target('georef','{}')")
	raises(db, psycopg.errors.InvalidParameterValue, "SELECT audit.remove_benchmark_target('deadwood',%s)", (dataset,))
