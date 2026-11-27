"""The audit framework (docs/audit-checks.md): versions and rules, runs and finish_run, the run that
counts (audit.current_runs), and who may read and write what. Shared helpers for the audit tests."""

import json

import psycopg
import pytest

from api.tests.db.test_acquisition_date_estimates import (  # noqa: F401
	PROCESSOR_EMAIL,
	act_as,
	act_as_anon,
	as_admin,
	create_dataset,
	create_user,
	db,
	processor_user,
)

SHA = 'a' * 64
SQUARE = {
	'type': 'Polygon',
	'coordinates': [[[7.8, 48.0], [7.8005, 48.0], [7.8005, 48.0005], [7.8, 48.0005], [7.8, 48.0]]],
}
PQ_RULES = {'decider': 'haiku'}
DE_RULES = {'decider': 'haiku', 'band_major_at': 90}


def as_worker(db):
	as_admin(db)
	act_as(db, processor_user(db), PROCESSOR_EMAIL)


def create_operator(db):
	user = create_user(db, can_audit=True)
	db.execute('UPDATE public.privileged_users SET can_operate=true WHERE user_id=%s', (user,))
	return user


def raises(db, error, sql, params=()):
	"""The statement fails with error and leaves the transaction usable."""
	db.execute('SAVEPOINT expect_error')
	with pytest.raises(error):
		db.execute(sql, params)
	db.execute('ROLLBACK TO SAVEPOINT expect_error')


def register_version(db, check='prediction_quality', version='v1', rules=None, active=True, **config):
	"""The worker registers a version and its rules switched off; an operator switches both on."""
	as_worker(db)
	version_id = db.execute(
		'INSERT INTO audit.check_versions(check_key,version,config) VALUES (%s,%s,%s) RETURNING id',
		(check, version, json.dumps({'models': ['haiku-5.5', 'luna-medium'], **config})),
	).fetchone()[0]
	if rules is None:
		rules = DE_RULES if check == 'dataset_evaluation' else PQ_RULES
	rules_id = add_rules(db, version_id, rules)
	if active:
		as_admin(db)
		db.execute('SELECT audit.activate_rules(%s)', (rules_id,))
		db.execute('SELECT audit.activate_version(%s)', (version_id,))
	as_admin(db)
	return version_id


def add_rules(db, version_id, rules, name='rules-v1'):
	as_worker(db)
	rules_id = db.execute(
		'INSERT INTO audit.check_rules(version_id,name,config) VALUES (%s,%s,%s) RETURNING id',
		(version_id, name, json.dumps(rules)),
	).fetchone()[0]
	as_admin(db)
	return rules_id


def create_run(db, dataset, version_id, check='prediction_quality', status='queued'):
	as_worker(db)
	run = db.execute(
		'INSERT INTO audit.runs(check_key,version_id,dataset_id,queue,status,started_at) '
		"VALUES (%s,%s,%s,'upload',%s,now()) RETURNING id",
		(check, version_id, dataset, status),
	).fetchone()[0]
	as_admin(db)
	return run


def tile(x0=0, off_grid=False, shift=0.0):
	"""A tile on the grid (window from x0) or off it; shift moves its footprint east, in degrees."""
	window = None if off_grid else [x0, 0, x0 + 512, 512]
	geometry = {'type': 'Polygon', 'coordinates': [[[x + shift, y] for x, y in SQUARE['coordinates'][0]]]}
	return {'pixel_window': window, 'geometry': geometry, 'mpp': 0.05, 'size_px': 1024}


def tile_judgement(index, layer, judge, verdict, likelihood=50, summary=None, errors=()):
	return {
		'tile_index': index,
		'layer': layer,
		'judge': judge,
		'verdict': verdict,
		'likelihood': likelihood,
		'problems': {'m1_dead_missed': {'likelihood': likelihood, 'area_pct': 5}},
		'summary': summary,
		'raw': {'errors': list(errors)},
	}


def dataset_judgement(judge, verdict, cog=False, thumbnail=False, reason=None, summary=None):
	return {
		'judge': judge,
		'verdict': verdict,
		'likelihood': 90 if verdict == 'major' else 10,
		'cog_issue': cog,
		'thumbnail_issue': thumbnail,
		'exclude_reason': reason,
		'summary': summary,
		'raw': {'reason': reason},
	}


def finish(db, run, labels=None, sha=SHA, tiles=(), images=(), dataset_judgements=(), tile_judgements=(), evidence=None):
	"""The worker finishes a run the way the processor does."""
	inputs = {'ortho_sha256': sha}
	if labels:
		inputs['label_ids'] = labels
	as_worker(db)
	db.execute(
		'SELECT audit.finish_run(%s,%s)',
		(
			run,
			json.dumps(
				{
					'inputs': inputs,
					'evidence': evidence or {'coverage': {'tiles': len(tiles)}},
					'tiles': list(tiles),
					'images': list(images),
					'dataset_judgements': list(dataset_judgements),
					'tile_judgements': list(tile_judgements),
				}
			),
		),
	)
	as_admin(db)
	return run


def pq_run(db, dataset, version_id, labels, judgements, sha=SHA):
	"""A done prediction quality run: tiles 1..n on the grid and their judgements."""
	count = max(j['tile_index'] for j in judgements)
	return finish(
		db,
		create_run(db, dataset, version_id),
		labels=labels,
		sha=sha,
		tiles=[tile(512 * i) for i in range(count)],
		tile_judgements=judgements,
	)


def tile_ids(db, run):
	as_admin(db)
	return [
		r[0]
		for r in db.execute(
			'SELECT DISTINCT tile_id FROM audit.tile_vlm_judgements WHERE run_id=%s ORDER BY tile_id', (run,)
		)
	]


def add_labels(db, dataset):
	"""A deadwood and a forest cover prediction of the dataset, as {layer: label id}."""
	as_admin(db)
	owner = db.execute('SELECT user_id FROM public.v2_datasets WHERE id=%s', (dataset,)).fetchone()[0]
	return {
		layer: db.execute(
			'INSERT INTO public.v2_labels(dataset_id,user_id,label_source,label_type,label_data) '
			"VALUES (%s,%s,'model_prediction','semantic_segmentation',%s) RETURNING id",
			(dataset, owner, layer),
		).fetchone()[0]
		for layer in ('deadwood', 'forest_cover')
	}


def current(db, dataset, check='prediction_quality'):
	as_admin(db)
	return db.execute(
		'SELECT run_id, rules_id, is_active_version FROM audit.current_runs WHERE dataset_id=%s AND check_key=%s',
		(dataset, check),
	).fetchone()


def rules_of(db, version_id):
	as_admin(db)
	return db.execute('SELECT id FROM audit.check_rules WHERE version_id=%s AND is_active', (version_id,)).fetchone()[0]


# ---------------------------------------------------------------------------
# Versions and rules
# ---------------------------------------------------------------------------


def test_the_worker_registers_versions_and_rules_switched_off_and_operators_switch_them_on(db):
	operator, auditor = create_operator(db), create_user(db, can_audit=True)
	first = register_version(db, version='v-first')
	as_worker(db)
	raises(
		db,
		psycopg.errors.InsufficientPrivilege,
		"INSERT INTO audit.check_versions(check_key,version,is_active) VALUES ('prediction_quality','v-on',true)",
	)
	second = register_version(db, version='v-second', active=False)
	rules = db.execute('SELECT id FROM audit.check_rules WHERE version_id=%s', (second,)).fetchone()[0]
	as_worker(db)
	raises(db, psycopg.errors.InsufficientPrivilege, 'UPDATE audit.check_versions SET is_active=true WHERE id=%s', (second,))
	raises(db, psycopg.errors.InsufficientPrivilege, 'SELECT audit.activate_version(%s)', (second,))
	act_as(db, auditor)
	raises(
		db,
		psycopg.errors.InsufficientPrivilege,
		"INSERT INTO audit.check_versions(check_key,version) VALUES ('prediction_quality','v-auditor')",
	)
	raises(db, psycopg.errors.InsufficientPrivilege, 'SELECT audit.activate_rules(%s)', (rules,))

	# a version goes on together with its rules
	act_as(db, operator)
	raises(db, psycopg.errors.ObjectNotInPrerequisiteState, 'SELECT audit.activate_version(%s)', (second,))
	db.execute('SELECT audit.activate_rules(%s)', (rules,))
	db.execute('SELECT audit.activate_version(%s)', (second,))
	as_admin(db)
	assert db.execute(
		'SELECT id, is_active, activated_at IS NOT NULL FROM audit.check_versions WHERE id IN (%s,%s) ORDER BY id',
		(first, second),
	).fetchall() == [(first, False, True), (second, True, True)]
	# what a version asks never changes; a new question is a new version
	raises(db, psycopg.errors.ObjectNotInPrerequisiteState, "UPDATE audit.check_versions SET config='{}' WHERE id=%s", (second,))
	raises(db, psycopg.errors.ObjectNotInPrerequisiteState, "UPDATE audit.check_rules SET config='{}' WHERE id=%s", (rules,))


def test_one_rule_set_per_version_is_active(db):
	version = register_version(db, version='v-rules')
	strict = add_rules(db, version, {'decider': 'luna'}, name='rules-v2')
	as_admin(db)
	db.execute('SELECT audit.activate_rules(%s)', (strict,))
	assert db.execute('SELECT name FROM audit.check_rules WHERE version_id=%s AND is_active', (version,)).fetchall() == [
		('rules-v2',)
	]


# ---------------------------------------------------------------------------
# finish_run
# ---------------------------------------------------------------------------


def test_finish_run_stores_a_run_whole_and_reuses_its_tiles(db):
	dataset = create_dataset(db, create_user(db))
	labels = add_labels(db, dataset)
	version = register_version(db, version='v-finish')
	run = create_run(db, dataset, version)
	image = {'content_type': 'image/jpeg', 'width': 1024, 'height': 1024}
	images = [
		{**image, 'tile_index': 1, 'kind': 'raw', 'storage_path': 'audit/pq/1/raw.jpg'},
		{**image, 'tile_index': 1, 'prediction_label_id': labels['deadwood'], 'kind': 'deadwood_overlay', 'storage_path': 'audit/pq/1/dw.jpg'},
	]
	finish(
		db,
		run,
		labels=labels,
		tiles=[tile(0), tile(off_grid=True)],
		images=images,
		tile_judgements=[
			tile_judgement(1, 'deadwood', 'haiku-5.5', 'major'),
			tile_judgement(2, 'forest_cover', 'haiku-5.5', 'not_assessable'),
		],
		evidence={'coverage': {'tiles': 2}, 'cost': {'haiku-5.5': {'calls': 2}}},
	)
	assert db.execute(
		"SELECT status::text, finished_at IS NOT NULL, error, inputs->'label_ids', evidence->'cost' FROM audit.runs WHERE id=%s",
		(run,),
	).fetchone() == ('done', True, None, labels, {'haiku-5.5': {'calls': 2}})
	assert db.execute('SELECT count(*) FROM audit.images WHERE run_id=%s', (run,)).fetchone() == (2,)
	first = tile_ids(db, run)

	# a rerun finds the same window and footprint again, on a new ortho too: the tile carries over
	rerun = finish(
		db,
		create_run(db, dataset, version),
		labels=labels,
		sha='b' * 64,
		tiles=[tile(off_grid=True), tile(0)],
		tile_judgements=[tile_judgement(1, 'deadwood', 'haiku-5.5', 'ok'), tile_judgement(2, 'deadwood', 'haiku-5.5', 'ok')],
	)
	assert tile_ids(db, rerun) == first
	assert db.execute('SELECT count(*) FROM audit.tiles WHERE dataset_id=%s', (dataset,)).fetchone() == (2,)
	# a finished run is not finished again
	as_worker(db)
	raises(db, psycopg.errors.ObjectNotInPrerequisiteState, "SELECT audit.finish_run(%s,'{}')", (run,))


def test_a_tile_is_its_window_and_footprint(db):
	"""A window is a pixel box of one ortho: after a rewrite that moves the image it is another place."""
	dataset = create_dataset(db, create_user(db))
	version = register_version(db, version='v-footprint')
	judged = [tile_judgement(1, 'deadwood', 'haiku-5.5', 'ok')]
	first = finish(db, create_run(db, dataset, version), tiles=[tile(0)], tile_judgements=judged)
	same = finish(db, create_run(db, dataset, version), sha='b' * 64, tiles=[tile(0)], tile_judgements=judged)
	moved = finish(db, create_run(db, dataset, version), sha='c' * 64, tiles=[tile(0, shift=0.0001)], tile_judgements=judged)
	assert tile_ids(db, same) == tile_ids(db, first)
	assert tile_ids(db, moved) != tile_ids(db, first)
	assert db.execute('SELECT count(*) FROM audit.tiles WHERE dataset_id=%s', (dataset,)).fetchone() == (2,)


def test_a_bad_payload_stores_nothing(db):
	dataset = create_dataset(db, create_user(db))
	run = create_run(db, dataset, register_version(db, version='v-bad'))
	image = {'content_type': 'image/jpeg', 'width': 1, 'height': 1, 'storage_path': 'a.jpg'}
	as_worker(db)
	for payload, error in (
		({'tiles': [tile(0)], 'tile_judgements': [tile_judgement(2, 'deadwood', 'haiku-5.5', 'ok')]}, psycopg.errors.InvalidParameterValue),
		({'tiles': [tile(0)], 'tile_judgements': [tile_judgement(1, 'deadwood', 'haiku-5.5', 'unsure')]}, psycopg.errors.InvalidTextRepresentation),
		({'tiles': [tile(0)], 'tile_judgements': [tile_judgement(1, 'image', 'haiku-5.5', 'ok')]}, psycopg.errors.CheckViolation),
		({'images': [{**image, 'kind': 'raw'}]}, psycopg.errors.CheckViolation),
	):
		raises(db, error, 'SELECT audit.finish_run(%s,%s)', (run, json.dumps(payload)))
	as_admin(db)
	assert db.execute('SELECT status::text FROM audit.runs WHERE id=%s', (run,)).fetchone() == ('queued',)
	assert db.execute('SELECT count(*) FROM audit.tiles WHERE dataset_id=%s', (dataset,)).fetchone() == (0,)


def test_only_the_audit_worker_writes_runs_and_nobody_writes_the_models_answers(db):
	auditor, operator = create_user(db, can_audit=True), create_operator(db)
	dataset = create_dataset(db, create_user(db))
	version = register_version(db, version='v-access')
	run = create_run(db, dataset, version)
	for user in (auditor, operator):
		act_as(db, user)
		raises(db, psycopg.errors.InsufficientPrivilege, "SELECT audit.finish_run(%s,'{}')", (run,))
		raises(
			db,
			psycopg.errors.InsufficientPrivilege,
			"INSERT INTO audit.runs(check_key,version_id,dataset_id,queue) VALUES ('prediction_quality',%s,%s,'manual')",
			(version, dataset),
		)
		assert db.execute("UPDATE audit.runs SET status='failed', error='x', finished_at=now() WHERE id=%s", (run,)).rowcount == 0
	finish(db, run, tiles=[tile(0)], tile_judgements=[tile_judgement(1, 'deadwood', 'haiku-5.5', 'ok')])
	tile_id = tile_ids(db, run)[0]
	# the worker itself writes tiles, images and judgements only through finish_run
	for user, email in ((auditor, None), (operator, None), (processor_user(db), PROCESSOR_EMAIL)):
		act_as(db, user, email)
		raises(
			db,
			psycopg.errors.InsufficientPrivilege,
			"INSERT INTO audit.tile_vlm_judgements(run_id,dataset_id,tile_id,layer,judge,verdict) VALUES (%s,%s,%s,'deadwood','x','ok')",
			(run, dataset, tile_id),
		)
		raises(
			db,
			psycopg.errors.InsufficientPrivilege,
			"INSERT INTO audit.dataset_vlm_judgements(run_id,dataset_id,judge,verdict) VALUES (%s,%s,'x','ok')",
			(run, dataset),
		)
		raises(db, psycopg.errors.InsufficientPrivilege, 'UPDATE audit.tiles SET mpp=1 WHERE id=%s', (tile_id,))
	# a model's answer is never rewritten, not even by the owner
	as_admin(db)
	raises(
		db,
		psycopg.errors.ObjectNotInPrerequisiteState,
		"UPDATE audit.tile_vlm_judgements SET verdict='major' WHERE run_id=%s",
		(run,),
	)
	# the service role may finish runs too (scripts)
	other = create_run(db, dataset, version)
	db.execute("SELECT audit.finish_run(%s,'{}')", (other,))
	assert db.execute('SELECT status::text FROM audit.runs WHERE id=%s', (other,)).fetchone() == ('done',)


# ---------------------------------------------------------------------------
# The run that counts
# ---------------------------------------------------------------------------


def test_a_dataset_keeps_its_last_result_while_its_rerun_waits(db):
	dataset = create_dataset(db, create_user(db))
	old = register_version(db, version='v-old')
	old_run = pq_run(db, dataset, old, {'deadwood': 1}, [tile_judgement(1, 'deadwood', 'haiku-5.5', 'ok')])
	assert current(db, dataset) == (old_run, rules_of(db, old), True)

	new = register_version(db, version='v-new')
	# activation queues nothing; until a run of the new version is done the old one counts, with its own rules
	assert db.execute('SELECT count(*) FROM audit.runs WHERE version_id=%s', (new,)).fetchone() == (0,)
	assert current(db, dataset) == (old_run, rules_of(db, old), False)
	create_run(db, dataset, new)
	create_run(db, dataset, new, status='running')
	as_worker(db)
	db.execute(
		'INSERT INTO audit.runs(check_key,version_id,dataset_id,queue,status,error,finished_at) '
		"VALUES ('prediction_quality',%s,%s,'manual','failed','model login expired',now())",
		(new, dataset),
	)
	assert current(db, dataset)[0] == old_run
	new_run = pq_run(db, dataset, new, {'deadwood': 1}, [tile_judgement(1, 'deadwood', 'haiku-5.5', 'major')])
	assert current(db, dataset) == (new_run, rules_of(db, new), True)
	# a later done run of the active version replaces it; one of an older version never does
	newer = pq_run(db, dataset, new, {'deadwood': 1}, [tile_judgement(1, 'deadwood', 'haiku-5.5', 'ok')])
	pq_run(db, dataset, old, {'deadwood': 1}, [tile_judgement(1, 'deadwood', 'haiku-5.5', 'ok')])
	assert current(db, dataset)[0] == newer


# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------


def test_auditors_read_the_audit_and_other_users_see_nothing(db):
	auditor, stranger = create_user(db, can_audit=True), create_user(db)
	dataset = create_dataset(db, create_user(db), access='private')
	pq_run(db, dataset, register_version(db, version='v-read'), {'deadwood': 1}, [tile_judgement(1, 'deadwood', 'haiku-5.5', 'ok')])
	tables = ('check_versions', 'check_rules', 'runs', 'tiles', 'tile_vlm_judgements', 'current_runs', 'tile_calls')
	act_as(db, auditor)
	for table in tables:
		assert db.execute(f'SELECT count(*) > 0 FROM audit.{table}').fetchone() == (True,), table
	act_as(db, stranger)
	for table in tables:
		assert db.execute(f'SELECT count(*) FROM audit.{table}').fetchone() == (0,), table
	act_as_anon(db)
	raises(db, psycopg.errors.InsufficientPrivilege, 'SELECT * FROM audit.runs')


def test_auditors_add_their_own_reviews_and_only_operators_add_benchmark_labels(db):
	auditor, operator, stranger = create_user(db, can_audit=True), create_operator(db), create_user(db)
	dataset = create_dataset(db, create_user(db))
	labels = add_labels(db, dataset)
	run = pq_run(db, dataset, register_version(db, version='v-reviews'), labels, [tile_judgement(1, 'deadwood', 'haiku-5.5', 'ok')])
	tile_id = tile_ids(db, run)[0]
	review = (
		'INSERT INTO audit.dataset_human_reviews(dataset_id,check_key,decision,reviewed_by,in_benchmark) '
		"VALUES (%s,'dataset_evaluation','keep',%s,%s)"
	)
	tile_review = (
		'INSERT INTO audit.tile_human_reviews(dataset_id,tile_id,layer,prediction_label_id,verdict,reviewed_by,in_benchmark) '
		"VALUES (%s,%s,'deadwood',%s,'minor',%s,%s)"
	)
	act_as(db, auditor)
	db.execute(review, (dataset, auditor, False))
	db.execute(tile_review, (dataset, tile_id, labels['deadwood'], auditor, False))
	# not in someone else's name, not as a benchmark label, not without the prediction it showed
	raises(db, psycopg.errors.InsufficientPrivilege, review, (dataset, operator, False))
	raises(db, psycopg.errors.InsufficientPrivilege, review, (dataset, auditor, True))
	raises(db, psycopg.errors.InsufficientPrivilege, tile_review, (dataset, tile_id, labels['deadwood'], auditor, True))
	raises(db, psycopg.errors.InsufficientPrivilege, tile_review, (dataset, tile_id, None, auditor, False))
	# the evidence key is the database's, and a review is never changed
	raises(
		db,
		psycopg.errors.InsufficientPrivilege,
		"INSERT INTO audit.dataset_human_reviews(dataset_id,check_key,decision,evidence_key) VALUES (%s,'dataset_evaluation','keep','x')",
		(dataset,),
	)
	raises(db, psycopg.errors.InsufficientPrivilege, 'UPDATE audit.dataset_human_reviews SET in_benchmark=true WHERE dataset_id=%s', (dataset,))
	raises(db, psycopg.errors.InsufficientPrivilege, 'DELETE FROM audit.tile_human_reviews WHERE dataset_id=%s', (dataset,))
	act_as(db, operator)
	db.execute(review, (dataset, operator, True))
	db.execute(tile_review, (dataset, tile_id, labels['deadwood'], operator, True))
	act_as(db, stranger)
	raises(db, psycopg.errors.InsufficientPrivilege, review, (dataset, stranger, False))
	# reviewed_by defaults to the caller
	act_as(db, auditor)
	db.execute("INSERT INTO audit.dataset_human_reviews(dataset_id,check_key,georef_status) VALUES (%s,'georef','passed')", (dataset,))
	as_admin(db)
	assert db.execute(
		"SELECT reviewed_by FROM audit.dataset_human_reviews WHERE dataset_id=%s AND check_key='georef'", (dataset,)
	).fetchone() == (auditor,)


def test_a_review_carries_only_the_columns_of_its_check(db):
	dataset = create_dataset(db, create_user(db))
	as_admin(db)
	for check, columns in (
		('dataset_evaluation', {'georef_status': 'passed'}),
		('dataset_evaluation', {'decision': 'keep', 'exclude_reason': 'blurry'}),
		('georef', {'decision': 'keep'}),
		('acquisition_date', {'georef_status': 'passed'}),
		('prediction_quality', {'decision': 'keep'}),
	):
		names = ','.join(columns)
		raises(
			db,
			psycopg.errors.CheckViolation,
			f'INSERT INTO audit.dataset_human_reviews(dataset_id,check_key,{names}) VALUES (%s,%s{",%s" * len(columns)})',
			(dataset, check, *columns.values()),
		)


def test_operators_queue_runs_of_the_active_version_by_hand(db):
	"""The worker queues nothing itself (DT-1619): an operator queues the datasets to judge."""
	operator, auditor = create_operator(db), create_user(db, can_audit=True)
	first, second = create_dataset(db, create_user(db)), create_dataset(db, create_user(db))
	version_id = register_version(db)

	def queue(user, ids, again=False):
		act_as(db, user)
		return db.execute("SELECT audit.queue_runs('prediction_quality', %s, 'manual', %s)", (ids, again)).fetchone()[0]

	act_as(db, auditor)
	raises(db, psycopg.errors.InsufficientPrivilege, "SELECT audit.queue_runs('prediction_quality', ARRAY[1]::bigint[])")
	assert queue(operator, [first, second]) == 2
	# an open run is not queued twice, a finished one only when asked again
	assert queue(operator, [first, second]) == 0
	as_admin(db)
	db.execute("UPDATE audit.runs SET status='done', finished_at=now() WHERE dataset_id=%s", (first,))
	assert queue(operator, [first]) == 0 and queue(operator, [first], again=True) == 1
	as_admin(db)
	assert db.execute(
		"SELECT count(*) FROM audit.runs WHERE version_id=%s AND queue='manual' AND status='queued'", (version_id,)
	).fetchone()[0] == 2
	act_as(db, operator)
	raises(db, psycopg.errors.ObjectNotInPrerequisiteState, "SELECT audit.queue_runs('dataset_evaluation', ARRAY[1]::bigint[])")


def test_a_benchmark_tick_queues_a_dataset_evaluation_run(db):
	"""A dataset ticked into the benchmark gets its images (DT-1624): a run of the active version,
	unless one is open or done. Without an active version the label is stored all the same."""
	operator = create_operator(db)
	never, judged, unticked = (create_dataset(db, create_user(db)) for _ in range(3))
	review = (
		'INSERT INTO audit.dataset_human_reviews(dataset_id,check_key,decision,reviewed_by,in_benchmark) '
		"VALUES (%s,'dataset_evaluation','keep',%s,%s)"
	)

	def runs():
		as_admin(db)
		return db.execute(
			"SELECT dataset_id, queue, status FROM audit.runs WHERE check_key='dataset_evaluation' ORDER BY dataset_id"
		).fetchall()

	act_as(db, operator)
	db.execute(review, (never, operator, True))
	assert runs() == []
	version_id = register_version(db, check='dataset_evaluation')
	create_run(db, judged, version_id, check='dataset_evaluation')
	db.execute("UPDATE audit.runs SET status='done', finished_at=now() WHERE dataset_id=%s", (judged,))
	act_as(db, operator)
	for dataset, ticked in ((never, True), (never, True), (judged, True), (unticked, False)):
		db.execute(review, (dataset, operator, ticked))
	assert runs() == [(never, 'manual', 'queued'), (judged, 'upload', 'done')]


def test_read_policies_evaluate_access_once_per_statement(db):
	"""A bare function call in USING runs per row; over large tables that hit the statement timeout (DT-1532)."""
	policies = db.execute(
		"SELECT tablename, policyname, qual FROM pg_policies WHERE schemaname='audit' AND cmd IN ('SELECT','ALL','UPDATE') AND qual <> 'true'"
	).fetchall()
	assert len(policies) >= 11
	assert [(table, name) for table, name, qual in policies if not qual.startswith('( SELECT ')] == []


def test_analyst_reads_every_audit_table_and_view_without_writing(db):
	dataset = create_dataset(db, create_user(db), access='private')
	pq_run(db, dataset, register_version(db, version='v-analyst'), {'deadwood': 1}, [tile_judgement(1, 'deadwood', 'haiku-5.5', 'ok')])
	relations = [
		r[0] for r in db.execute("SELECT relname FROM pg_class WHERE relnamespace='audit'::regnamespace AND relkind IN ('r','v')")
	]
	assert {'dataset_human_reviews', 'tile_human_reviews', 'dataset_outcomes', 'evaluation_decisions'} <= set(relations)
	db.execute('SET SESSION AUTHORIZATION team_analyst')
	for relation in relations:
		db.execute(f'SELECT * FROM audit.{relation} LIMIT 1').fetchall()
	assert db.execute('SELECT count(*) FROM audit.tile_vlm_judgements WHERE dataset_id=%s', (dataset,)).fetchone() == (1,)
	raises(db, psycopg.errors.InsufficientPrivilege, 'DELETE FROM audit.tile_vlm_judgements WHERE dataset_id=%s', (dataset,))
	raises(db, psycopg.errors.InsufficientPrivilege, "SELECT audit.finish_run(1, '{}')")


def test_the_old_objects_are_gone(db):
	assert db.execute(
		"SELECT to_regclass('audit.assessments'), to_regclass('audit.crops'), to_regclass('audit.benchmarks'),"
		" to_regclass('audit.image_hashes'), to_regclass('public.dataset_audit_suggestions'), to_regclass('audit.dataset_results'),"
		" to_regtype('audit.check_mode'), to_regtype('audit.assessor_kind'),"
		" to_regprocedure('audit.store_dataset_evaluation(bigint,jsonb)'), to_regprocedure('audit.benchmark_split(bigint)')"
	).fetchone() == (None,) * 10
	assert db.execute("SELECT relkind::text FROM pg_class WHERE oid='audit.current_runs'::regclass").fetchone() == ('v',)
	assert db.execute('SELECT enum_range(NULL::audit.verdict)::text[]').fetchone() == (
		['ok', 'minor', 'major', 'ambiguous', 'not_assessable'],
	)


# ---------------------------------------------------------------------------
# The prediction quality check's windowed reads (DT-1619)
# ---------------------------------------------------------------------------

TILE_DEG = 0.001


def envelope(x0, y0=48.0, x1=None, y1=None):
	"""A WKT box from x0 (degrees east), one tile wide and high unless given."""
	x1, y1 = x1 if x1 is not None else x0 + TILE_DEG, y1 if y1 is not None else y0 + TILE_DEG
	return f'SRID=4326;POLYGON(({x0} {y0},{x1} {y0},{x1} {y1},{x0} {y1},{x0} {y0}))'


def polygon(x0, y0=48.0, x1=None, y1=None):
	x1, y1 = x1 if x1 is not None else x0 + TILE_DEG, y1 if y1 is not None else y0 + TILE_DEG
	return {'type': 'Polygon', 'coordinates': [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


def pq_inputs(db, tiles=5):
	"""A private dataset whose embedding stage is done: tiles in a row eastwards from 7.8, and its
	deadwood and forest predictions (deadwood on the left half of tile 0, a deleted deadwood
	polygon on tile 1, another label's deadwood on tile 2, forest twice over tile 1)."""
	dataset = create_dataset(db, create_user(db), access='private')
	as_admin(db)
	db.execute('INSERT INTO public.v2_statuses(dataset_id,is_embeddings_done) VALUES (%s,true)', (dataset,))
	for n in range(tiles):
		db.execute(
			'INSERT INTO public.v2_tile_embeddings(dataset_id,geometry,embedding,pixel_x0,pixel_y0,pixel_x1,pixel_y1) '
			'VALUES (%s,%s,array_fill(0,array[1024])::vector,%s,0,%s,512)',
			(dataset, envelope(7.8 + n * TILE_DEG), 512 * n, 512 * (n + 1)),
		)
	labels = add_labels(db, dataset)
	other = add_labels(db, dataset)['deadwood']
	for label, geometry, deleted, table in (
		(labels['deadwood'], envelope(7.8, x1=7.8005), False, 'deadwood'),
		(labels['deadwood'], envelope(7.801), True, 'deadwood'),
		(other, envelope(7.802), False, 'deadwood'),
		(labels['forest_cover'], envelope(7.801), False, 'forest_cover'),
		(labels['forest_cover'], envelope(7.801), False, 'forest_cover'),
	):
		db.execute(
			f'INSERT INTO public.v2_{table}_geometries(label_id,geometry,is_deleted) VALUES (%s,%s,%s)',
			(label, geometry, deleted),
		)
	return dataset, labels


def candidates(db, dataset, aoi=None, limit=500):
	return db.execute(
		'SELECT audit.prediction_quality_candidates(%s,%s,%s,0.9)', (dataset, json.dumps(aoi) if aoi else None, limit)
	).fetchone()[0]


def pq_cover(db, label, boxes):
	return db.execute('SELECT audit.prediction_quality_cover(%s,%s)', (label, json.dumps(boxes))).fetchone()[0]


def pq_polygons(db, label, boxes):
	return db.execute('SELECT audit.prediction_quality_polygons(%s,%s)', (label, json.dumps(boxes))).fetchone()[0]


def test_the_check_draws_a_fixed_sample_of_tiles(db):
	dataset, _ = pq_inputs(db)
	as_worker(db)
	drawn = candidates(db, dataset, limit=3)
	assert (drawn['tiles'], drawn['tiles_inside'], len(drawn['candidates'])) == (5, 5, 3)
	# the same data draws the same tiles, a larger sample draws more in the same order
	assert candidates(db, dataset, limit=3) == drawn
	everything = candidates(db, dataset)['candidates']
	assert everything[:3] == drawn['candidates'] and len(everything) == 5
	tile = everything[0]
	assert set(tile) == {'id', 'pixel_window', 'geometry', 'aoi'} and tile['aoi'] == 1
	assert tile['geometry']['type'] == 'Polygon' and tile['pixel_window'][2] - tile['pixel_window'][0] == 512


def test_the_cover_of_a_prediction_is_its_share_of_each_box(db):
	_, labels = pq_inputs(db)
	as_worker(db)
	tiles = [[7.8 + n * TILE_DEG, 48.0, 7.8 + (n + 1) * TILE_DEG, 48.001] for n in range(3)]
	# deleted polygons and other labels do not count; overlapping polygons are clamped to the box
	assert [round(c, 6) for c in pq_cover(db, labels['deadwood'], tiles)] == [0.5, 0, 0]
	assert [round(c, 6) for c in pq_cover(db, labels['forest_cover'], tiles)] == [0, 1, 0]
	# a box half on the polygon, in the order given
	straddling = [7.80025, 48.0, 7.80075, 48.001]
	assert [round(c, 6) for c in pq_cover(db, labels['deadwood'], [tiles[2], straddling])] == [0, 0.5]
	assert pq_cover(db, labels['deadwood'], []) == []
	# a big polygon (over 64 KB) is cut once for all its boxes, to the same shares
	as_admin(db)
	db.execute(
		'INSERT INTO public.v2_forest_cover_geometries(label_id,geometry) '
		'SELECT %s, ST_Segmentize(ST_MakeEnvelope(7.803,48.0,7.8045,48.001,4326), 0.0000002)',
		(labels['forest_cover'],),
	)
	as_worker(db)
	boxes = [[7.803, 48.0, 7.804, 48.001], [7.804, 48.0, 7.805, 48.001]]
	assert [round(c, 6) for c in pq_cover(db, labels['forest_cover'], boxes)] == [1, 0.5]


def test_the_candidates_lie_inside_the_aoi(db):
	dataset, labels = pq_inputs(db)
	as_worker(db)
	# tiles 0 and 1 lie in the AOI, 30% of tile 2 does: two tiles inside
	inside = candidates(db, dataset, aoi=polygon(7.8, x1=7.8023))
	assert inside['tiles_inside'] == 2 and sorted(c['pixel_window'][0] for c in inside['candidates']) == [0, 512]
	# an AOI smaller than a tile: the tile it touches
	small = candidates(db, dataset, aoi=polygon(7.8031, 48.0001, 7.8035, 48.0005))
	assert small['tiles_inside'] == 1 and [c['pixel_window'][0] for c in small['candidates']] == [1536]
	assert round(small['candidates'][0]['aoi'], 6) == 0.16
	# before the embedding stage has finished, the dataset has no tiles to draw
	as_admin(db)
	db.execute('UPDATE public.v2_statuses SET is_embeddings_done=false WHERE dataset_id=%s', (dataset,))
	as_worker(db)
	assert candidates(db, dataset) == {'tiles': 0, 'tiles_inside': 0, 'candidates': []}


def test_the_polygons_of_a_prediction_are_cut_to_each_box(db):
	dataset, labels = pq_inputs(db)
	as_worker(db)
	tile0, tile1, tile2, far = ([7.8 + n * TILE_DEG, 48.0, 7.8 + (n + 1) * TILE_DEG, 48.001] for n in (0, 1, 2, 9))
	half, deleted, other, nothing = pq_polygons(db, labels['deadwood'], [tile0, tile1, tile2, far])
	assert len(half) == 1 and deleted == other == nothing == []
	xs = {x for x, _ in half[0]['coordinates'][0]}
	assert xs == {7.8, 7.8005}
	# cut to the box: the left quarter of tile 0 holds the left quarter of the polygon
	(quarter,) = pq_polygons(db, labels['deadwood'], [[7.8, 48.0, 7.80025, 48.001]])[0]
	assert {x for x, _ in quarter['coordinates'][0]} == {7.8, 7.80025}
	forest = pq_polygons(db, labels['forest_cover'], [tile1])
	assert len(forest[0]) == 2 and pq_polygons(db, labels['deadwood'], []) == []


def test_only_the_audit_worker_and_analysts_read_prediction_quality_inputs(db):
	dataset, labels = pq_inputs(db)
	box = [[7.8, 48.0, 7.801, 48.001]]
	sample = 'SELECT audit.prediction_quality_candidates(%s,null,10,0.9)'
	reads = ['SELECT audit.prediction_quality_cover(%s,%s)', 'SELECT audit.prediction_quality_polygons(%s,%s)']
	for user in (create_user(db, can_audit=True), create_operator(db)):
		act_as(db, user)
		raises(db, psycopg.errors.InsufficientPrivilege, sample, (dataset,))
		for read in reads:
			raises(db, psycopg.errors.InsufficientPrivilege, read, (labels['deadwood'], json.dumps(box)))
	act_as_anon(db)
	for read in reads:
		raises(db, psycopg.errors.InsufficientPrivilege, read, (labels['deadwood'], json.dumps(box)))
	# the analyst's benchmark runs of the check read the same way
	as_admin(db)
	db.execute('SET SESSION AUTHORIZATION team_analyst')
	assert candidates(db, dataset)['tiles'] == 5
	assert [round(c, 6) for c in pq_cover(db, labels['deadwood'], box)] == [0.5]
	assert len(pq_polygons(db, labels['deadwood'], box)[0]) == 1
