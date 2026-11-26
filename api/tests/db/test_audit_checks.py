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
