"""Audit check framework: who writes what, append-only assessments, views and the benchmark split."""

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
SQUARE = 'SRID=4326;POLYGON((7.8 48.0,7.8005 48.0,7.8005 48.0005,7.8 48.0005,7.8 48.0))'


def as_worker(db):
	as_admin(db)
	act_as(db, processor_user(db), PROCESSOR_EMAIL)


def create_operator(db):
	user = create_user(db)
	db.execute('INSERT INTO public.privileged_users(user_id,can_operate) VALUES (%s,true)', (user,))
	return user


def register_version(db, check='prediction_quality', version='v1', **config):
	as_worker(db)
	version_id = db.execute(
		'INSERT INTO audit.check_versions(check_key,version,config) VALUES (%s,%s,%s) RETURNING id',
		(check, version, json.dumps({'models': ['luna-medium', 'haiku-5.5'], 'prompt_version': 'v4', **config})),
	).fetchone()[0]
	as_admin(db)
	return version_id


def create_run(db, dataset, version_id, check='prediction_quality', current=True, source=None):
	as_worker(db)
	run = db.execute(
		'INSERT INTO audit.runs(check_key,check_version_id,dataset_id,queue,status,started_at,finished_at,source_run_id) '
		"VALUES (%s,%s,%s,'upload','done',now(),now(),%s) RETURNING id",
		(check, version_id, dataset, source),
	).fetchone()[0]
	if current:
		db.execute(
			'INSERT INTO audit.current_runs(dataset_id,check_key,run_id) VALUES (%s,%s,%s) '
			'ON CONFLICT (dataset_id,check_key) DO UPDATE SET run_id=excluded.run_id,updated_at=now()',
			(dataset, check, run),
		)
	as_admin(db)
	return run


def create_crop(db, dataset, sets=('exclude',), x0=0):
	as_worker(db)
	crop = db.execute(
		'INSERT INTO audit.crops(dataset_id,ortho_sha256,crop_sets,pixel_x0,pixel_y0,pixel_x1,pixel_y1,geometry,mpp,size_px,selection) '
		'VALUES (%s,%s,%s,%s,0,%s,512,%s,0.05,1024,%s) RETURNING id',
		(dataset, SHA, list(sets), x0, x0 + 512, SQUARE, json.dumps({s: {'picker': 'top-cover-v1'} for s in sets})),
	).fetchone()[0]
	as_admin(db)
	return crop


def model_row(db, dataset, run, crop, verdict, model='luna-medium', kind='model', layer='deadwood', version='v4'):
	as_worker(db)
	db.execute(
		'INSERT INTO audit.assessments(check_key,dataset_id,crop_id,run_id,layer,label_id,assessor_kind,model,prompt_version,'
		"verdict,major_likelihood,modes,raw) VALUES ('prediction_quality',%s,%s,%s,%s,42,%s,%s,%s,%s,70,%s,%s)",
		(
			dataset,
			crop,
			run,
			layer,
			kind,
			model,
			version,
			verdict,
			json.dumps({'m1_dead_missed': {'likelihood': 80, 'area_pct': 12}}),
			json.dumps({'text': 'reply'}),
		),
	)
	as_admin(db)


def person_row(db, auditor, dataset, crop, verdict, run=None, layer='deadwood'):
	act_as(db, auditor)
	db.execute(
		'INSERT INTO audit.assessments(check_key,dataset_id,crop_id,run_id,layer,assessor_kind,assessor_user_id,verdict,modes) '
		"VALUES ('prediction_quality',%s,%s,%s,%s,'person',%s,%s,%s)",
		(dataset, crop, run, layer, auditor, verdict, json.dumps({'m1_dead_missed': True})),
	)
	as_admin(db)


def create_off_grid_crop(db, dataset):
	"""A DT-1272 gold crop: centred on a prediction, native resolution, no CLIP grid window."""
	as_admin(db)
	return db.execute(
		'INSERT INTO audit.crops(dataset_id,ortho_sha256,crop_sets,geometry,mpp,size_px,selection) '
		'VALUES (%s,%s,\'{benchmark}\',%s,0.036,1400,\'{"benchmark": {"picker": "dt1272-gold"}}\') RETURNING id',
		(dataset, SHA, SQUARE),
	).fetchone()[0]


def count(db, table, dataset):
	return db.execute(f'SELECT count(*) FROM audit.{table} WHERE dataset_id=%s', (dataset,)).fetchone()[0]


def test_the_worker_registers_versions_and_only_operators_switch_mode_and_activate(db):
	version_id = register_version(db)
	as_worker(db)
	for mode, active in (('auto_apply', False), ('review_all', True)):
		with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
			db.execute(
				"INSERT INTO audit.check_versions(check_key,version,mode,is_active) VALUES ('georef','v9',%s,%s)",
				(mode, active),
			)
	assert db.execute("UPDATE audit.check_versions SET mode='auto_apply' WHERE id=%s", (version_id,)).rowcount == 0

	as_admin(db)
	operator = create_operator(db)
	act_as(db, operator)
	db.execute("UPDATE audit.check_versions SET mode='review_uncertain',is_active=true WHERE id=%s", (version_id,))
	assert db.execute(
		'SELECT mode,is_active,updated_by FROM audit.check_versions WHERE id=%s', (version_id,)
	).fetchone() == ('review_uncertain', True, operator)
	# config and version belong to the registered version; a change is a new version
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute("UPDATE audit.check_versions SET config='{}' WHERE id=%s", (version_id,))
	as_admin(db)
	with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState), db.transaction():
		db.execute("UPDATE audit.check_versions SET version='v1b' WHERE id=%s", (version_id,))
	# one active version per check
	second = register_version(db, version='v2')
	with pytest.raises(psycopg.errors.UniqueViolation), db.transaction():
		db.execute('UPDATE audit.check_versions SET is_active=true WHERE id=%s', (second,))


def test_worker_writes_evidence_and_model_rows_that_only_auditors_see(db):
	owner = create_user(db)
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, owner, access='private')
	run = create_run(db, dataset, register_version(db))
	crop = create_crop(db, dataset)
	as_worker(db)
	db.execute(
		'INSERT INTO audit.images(dataset_id,ortho_sha256,crop_id,kind,storage_path,content_type,width,height) '
		"VALUES (%s,%s,%s,'raw','audit/crops/1/raw.jpg','image/jpeg',1024,1024),"
		"(%s,%s,%s,'overview','audit/overviews/1.jpg','image/jpeg',2048,1600)",
		(dataset, SHA, crop, dataset, SHA, None),
	)
	db.execute(
		'INSERT INTO audit.images(dataset_id,ortho_sha256,crop_id,label_id,kind,storage_path,content_type,width,height) '
		"VALUES (%s,%s,%s,42,'deadwood_overlay','audit/crops/1/deadwood-42.png','image/png',1024,1024)",
		(dataset, SHA, crop),
	)
	with pytest.raises(psycopg.errors.UniqueViolation), db.transaction():
		# the raw crop is stored once per ortho
		db.execute(
			'INSERT INTO audit.images(dataset_id,ortho_sha256,crop_id,kind,storage_path,content_type,width,height) '
			"VALUES (%s,%s,%s,'raw','audit/crops/1/raw-2.jpg','image/jpeg',1024,1024)",
			(dataset, SHA, crop),
		)
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		db.execute(
			'INSERT INTO audit.images(dataset_id,ortho_sha256,kind,storage_path,content_type,width,height) '
			"VALUES (%s,%s,'thumbnail','../etc/passwd','image/jpeg',10,10)",
			(dataset, SHA),
		)
	as_admin(db)
	model_row(db, dataset, run, crop, 'major')
	model_row(db, dataset, run, crop, 'ok', model='band_check', kind='rule', layer='image')

	tables = ('runs', 'current_runs', 'crops', 'images', 'assessments')
	act_as(db, auditor)
	assert [count(db, t, dataset) for t in tables] == [1, 1, 1, 3, 2]
	# the dataset owner and the public see none of it
	for reader in (lambda: act_as(db, owner), lambda: act_as_anon(db)):
		reader()
		for table in tables:
			try:
				with db.transaction():
					assert count(db, table, dataset) == 0
			except psycopg.errors.InsufficientPrivilege:
				pass
	act_as(db, owner)
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute(
			"INSERT INTO audit.runs(check_key,check_version_id,dataset_id,queue) VALUES ('prediction_quality',%s,%s,'manual')",
			(1, dataset),
		)
	# auditors cannot write model rows
	act_as(db, auditor)
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute(
			'INSERT INTO audit.assessments(check_key,dataset_id,run_id,layer,assessor_kind,model,prompt_version,verdict) '
			"VALUES ('prediction_quality',%s,%s,'deadwood','model','luna-medium','v4','ok')",
			(dataset, run),
		)


def test_auditors_add_their_own_rows_and_nobody_rewrites_one(db):
	auditor, other = create_user(db, can_audit=True), create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	crop = create_crop(db, dataset)
	person_row(db, auditor, dataset, crop, 'minor')
	act_as(db, auditor)
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute(
			'INSERT INTO audit.assessments(check_key,dataset_id,layer,assessor_kind,assessor_user_id,verdict) '
			"VALUES ('georef',%s,'georef','person',%s,'major')",
			(dataset, other),
		)
	for statement in ("UPDATE audit.assessments SET verdict='ok'", 'DELETE FROM audit.assessments'):
		with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
			db.execute(statement + ' WHERE dataset_id=%s', (dataset,))
	as_admin(db)
	with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState), db.transaction():
		db.execute("UPDATE audit.assessments SET verdict='ok' WHERE dataset_id=%s", (dataset,))
	# a person row cannot carry model fields, a model row needs its run
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		db.execute(
			'INSERT INTO audit.assessments(check_key,dataset_id,layer,assessor_kind,assessor_user_id,model,verdict) '
			"VALUES ('georef',%s,'georef','person',%s,'luna-medium','ok')",
			(dataset, auditor),
		)
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		db.execute(
			'INSERT INTO audit.assessments(check_key,dataset_id,layer,assessor_kind,model,prompt_version,verdict) '
			"VALUES ('georef',%s,'georef','model','romav2','georef-rules-v1','ok')",
			(dataset,),
		)


def test_targets_must_belong_to_the_same_dataset_and_check(db):
	auditor = create_user(db, can_audit=True)
	first, second = (create_dataset(db, create_user(db)) for _ in range(2))
	version_id = register_version(db)
	run = create_run(db, first, version_id)
	crop = create_crop(db, first)
	for dataset, crop_id, run_id, check in (
		(second, crop, None, 'prediction_quality'),  # crop of another dataset
		(second, None, run, 'prediction_quality'),  # run of another dataset
		(first, None, run, 'georef'),  # run of another check
	):
		act_as(db, auditor)
		with pytest.raises(psycopg.errors.ForeignKeyViolation), db.transaction():
			db.execute(
				'INSERT INTO audit.assessments(check_key,dataset_id,crop_id,run_id,layer,assessor_kind,assessor_user_id,verdict) '
				"VALUES (%s,%s,%s,%s,'deadwood','person',%s,'ok')",
				(check, dataset, crop_id, run_id, auditor),
			)
	as_worker(db)
	with pytest.raises(psycopg.errors.ForeignKeyViolation), db.transaction():
		db.execute(
			"INSERT INTO audit.runs(check_key,check_version_id,dataset_id,queue) VALUES ('georef',%s,%s,'backfill')",
			(version_id, first),
		)
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		# a finished run carries its finish time, a failed run its error
		db.execute(
			'INSERT INTO audit.runs(check_key,check_version_id,dataset_id,queue,status,finished_at) '
			"VALUES ('prediction_quality',%s,%s,'backfill','failed',now())",
			(version_id, first),
		)


def test_a_crop_joins_more_sets_but_keeps_its_window(db):
	dataset = create_dataset(db, create_user(db))
	crop = create_crop(db, dataset)
	as_worker(db)
	db.execute(
		"UPDATE audit.crops SET crop_sets=crop_sets || '{training}', "
		'selection=selection || \'{"training": {"picker": "s2-stratified-v1", "stratum": 3}}\' WHERE id=%s',
		(crop,),
	)
	assert db.execute('SELECT crop_sets FROM audit.crops WHERE id=%s', (crop,)).fetchone() == (['exclude', 'training'],)
	with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState), db.transaction():
		db.execute("UPDATE audit.crops SET crop_sets='{training}' WHERE id=%s", (crop,))
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute('UPDATE audit.crops SET pixel_x0=1 WHERE id=%s', (crop,))
	with pytest.raises(psycopg.errors.UniqueViolation), db.transaction():
		db.execute(
			'INSERT INTO audit.crops(dataset_id,ortho_sha256,crop_sets,pixel_x0,pixel_y0,pixel_x1,pixel_y1,geometry,mpp,size_px) '
			"VALUES (%s,%s,'{training}',0,0,512,512,%s,0.05,1024)",
			(dataset, SHA, SQUARE),
		)


def test_latest_answers_and_disagreements_follow_the_current_run(db):
	janusch, clemens = create_user(db, can_audit=True), create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	version_id = register_version(db)
	old_run = create_run(db, dataset, version_id)
	crop, agreed = create_crop(db, dataset), create_crop(db, dataset, x0=512)
	model_row(db, dataset, old_run, crop, 'ok', model='haiku-5.5')
	run = create_run(db, dataset, version_id)
	model_row(db, dataset, run, crop, 'major')
	model_row(db, dataset, run, agreed, 'ok')
	person_row(db, janusch, dataset, crop, 'ok', run)
	person_row(db, janusch, dataset, crop, 'major', run)  # his correction
	person_row(db, clemens, dataset, crop, 'minor', run)
	person_row(db, clemens, dataset, agreed, 'ok', run)

	act_as(db, janusch)
	latest = db.execute(
		'SELECT assessor,verdict FROM audit.latest_assessments WHERE crop_id=%s ORDER BY assessor', (crop,)
	).fetchall()
	assert sorted(latest) == sorted(
		[(str(janusch), 'major'), (str(clemens), 'minor'), ('haiku-5.5/v4', 'ok'), ('luna-medium/v4', 'major')]
	)
	assert db.execute(
		'SELECT crop_id,people_disagree,people_and_models_disagree,verdicts FROM audit.disagreements WHERE dataset_id=%s',
		(dataset,),
	).fetchall() == [(crop, True, True, {str(janusch): 'major', str(clemens): 'minor', 'luna-medium/v4': 'major'})]
	# the earlier run's model answer stays in the table but no longer counts
	assert db.execute('SELECT count(*) FROM audit.assessments WHERE run_id=%s', (old_run,)).fetchone() == (1,)


def test_a_newer_run_that_is_not_current_does_not_hide_the_current_answers(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	version_id = register_version(db)
	run = create_run(db, dataset, version_id)
	crop = create_crop(db, dataset)
	model_row(db, dataset, run, crop, 'major')
	person_row(db, auditor, dataset, crop, 'ok', run)
	# a rerun writes an answer but fails before it becomes the current run
	rerun = create_run(db, dataset, version_id, current=False)
	model_row(db, dataset, rerun, crop, 'ok')
	act_as(db, auditor)
	assert db.execute('SELECT verdicts FROM audit.disagreements WHERE crop_id=%s', (crop,)).fetchall() == [
		({str(auditor): 'ok', 'luna-medium/v4': 'major'},)
	]


def import_legacy(db, auditor, dataset, verdict, created_at="now() - interval '1 year'", layer='deadwood'):
	as_admin(db)
	db.execute(
		'INSERT INTO audit.assessments(check_key,dataset_id,layer,assessor_kind,assessor_user_id,verdict,imported_from,created_at) '
		f"VALUES ('prediction_quality',%s,%s,'person',%s,%s,'dataset_audit',{created_at})",
		(dataset, layer, auditor, verdict),
	)


def test_imported_audits_never_count_as_people_agreeing_or_disagreeing(db):
	janusch, clemens, teja = (create_user(db, can_audit=True) for _ in range(3))
	dataset, quiet = (create_dataset(db, create_user(db)) for _ in range(2))
	run = create_run(db, dataset, register_version(db))
	as_worker(db)
	db.execute(
		'INSERT INTO audit.assessments(check_key,dataset_id,run_id,layer,assessor_kind,model,prompt_version,verdict) '
		"VALUES ('prediction_quality',%s,%s,'deadwood','model','luna-medium','v4','major')",
		(dataset, run),
	)
	as_admin(db)
	# old audits: Clemens said fine, Teja said bad; a later re-review by Janusch is native
	import_legacy(db, clemens, dataset, 'ok')
	import_legacy(db, teja, dataset, 'major')
	# imported rows that disagree only with each other are not an adjudication case
	import_legacy(db, clemens, quiet, 'ok')
	import_legacy(db, teja, quiet, 'major')

	act_as(db, janusch)
	assert db.execute(
		'SELECT people_disagree,people_and_models_disagree,legacy_and_models_disagree FROM audit.disagreements '
		'WHERE dataset_id=%s AND crop_id IS NULL',
		(dataset,),
	).fetchall() == [(False, False, True)]
	assert db.execute('SELECT count(*) FROM audit.disagreements WHERE dataset_id=%s', (quiet,)).fetchone() == (0,)

	# the same person's native answer replaces their imported one, even if the import is dated later
	import_legacy(db, janusch, dataset, 'ok', created_at="now() + interval '1 day'")
	person_row(db, janusch, dataset, None, 'major', run)
	act_as(db, janusch)
	assert db.execute(
		'SELECT verdict,imported_from FROM audit.latest_assessments WHERE dataset_id=%s AND assessor=%s',
		(dataset, str(janusch)),
	).fetchone() == ('major', None)
	assert db.execute(
		'SELECT count(*) FROM audit.latest_assessments WHERE dataset_id=%s AND imported_from IS NULL', (dataset,)
	).fetchone() == (2,)

	# only the service role marks rows as imported, and only person rows
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute(
			'INSERT INTO audit.assessments(check_key,dataset_id,layer,assessor_kind,assessor_user_id,verdict,imported_from) '
			"VALUES ('prediction_quality',%s,'deadwood','person',%s,'ok','dataset_audit')",
			(dataset, janusch),
		)
	as_worker(db)
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute(
			'INSERT INTO audit.assessments(check_key,dataset_id,run_id,layer,assessor_kind,model,prompt_version,verdict,imported_from) '
			"VALUES ('prediction_quality',%s,%s,'deadwood','model','luna-medium','v4','ok','dataset_audit')",
			(dataset, run),
		)
	as_admin(db)
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		db.execute(
			'INSERT INTO audit.assessments(check_key,dataset_id,run_id,layer,assessor_kind,model,prompt_version,verdict,imported_from) '
			"VALUES ('prediction_quality',%s,%s,'deadwood','model','luna-medium','v4','ok','dataset_audit')",
			(dataset, run),
		)


def test_api_roles_get_only_the_privileges_the_policies_use(db):
	tables = (
		'checks',
		'check_versions',
		'runs',
		'current_runs',
		'crops',
		'images',
		'assessments',
		'benchmarks',
		'benchmark_members',
		'benchmark_scores',
		'latest_assessments',
		'current_assessments',
		'disagreements',
		'review_queue',
	)
	granted = {
		(role, table): set(privileges)
		for role, table, privileges in db.execute(
			'SELECT grantee,table_name,array_agg(privilege_type::text) FROM information_schema.role_table_grants '
			"WHERE table_schema='audit' AND table_name=ANY(%s) AND grantee IN ('anon','authenticated') GROUP BY 1,2",
			(list(tables),),
		)
	}
	writes = {
		'check_versions': {'INSERT'},
		'runs': {'INSERT'},
		'current_runs': {'INSERT', 'UPDATE', 'DELETE'},
		'crops': {'INSERT'},
		'images': {'INSERT'},
		'assessments': {'INSERT'},
		'benchmarks': {'INSERT', 'DELETE'},
		'benchmark_members': {'INSERT', 'DELETE'},
		'benchmark_scores': {'INSERT'},
	}
	assert granted == {('authenticated', t): {'SELECT'} | writes.get(t, set()) for t in tables}
	# the remaining updates are column grants: run state, crop sets, version mode
	assert db.execute(
		"SELECT has_column_privilege('authenticated','audit.crops','pixel_x0','UPDATE'), "
		"has_column_privilege('authenticated','audit.crops','crop_sets','UPDATE'), "
		"has_column_privilege('authenticated','audit.check_versions','config','UPDATE')"
	).fetchone() == (False, True, False)


def queue(db, dataset):
	return db.execute(
		'SELECT layer,version,verdict,needs_review,reason,reviewed FROM audit.review_queue WHERE dataset_id=%s ORDER BY layer',
		(dataset,),
	).fetchall()


def test_a_rule_change_recomputes_from_the_stored_model_rows(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	run = create_run(db, dataset, register_version(db))
	crops = create_crop(db, dataset), create_crop(db, dataset, x0=512)
	model_row(db, dataset, run, crops[0], 'major')
	model_row(db, dataset, run, crops[1], 'ok')
	model_row(db, dataset, run, None, 'major', model='pq-dataset-rule', kind='rule', version='v1')

	# rule v2 (1 major crop of 2 is no longer enough) recomputes without calling a model
	rerun = create_run(db, dataset, register_version(db, version='v2', rule='pq-dataset-rule/v2'), source=run)
	model_row(db, dataset, rerun, None, 'ok', model='pq-dataset-rule', kind='rule', version='v2')
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		model_row(db, dataset, rerun, crops[0], 'ok')
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		create_run(db, dataset, register_version(db, version='v3'), source=rerun)

	act_as(db, auditor)
	assert sorted(
		db.execute(
			'SELECT crop_id IS NULL,assessor,verdict FROM audit.current_assessments WHERE dataset_id=%s', (dataset,)
		).fetchall()
	) == sorted(
		[(False, 'luna-medium/v4', 'major'), (False, 'luna-medium/v4', 'ok'), (True, 'pq-dataset-rule/v2', 'ok')]
	)
	assert queue(db, dataset) == [('deadwood', 'v2', 'ok', True, 'review_all', False)]
	# the v1 verdict stays as history
	assert db.execute(
		"SELECT count(*) FROM audit.assessments WHERE dataset_id=%s AND assessor='pq-dataset-rule/v1'", (dataset,)
	).fetchone() == (1,)


def test_the_review_queue_follows_the_mode_and_the_reviews(db):
	operator, auditor = create_operator(db), create_user(db, can_audit=True)
	version_id = register_version(db)
	act_as(db, operator)
	db.execute('SELECT audit.activate_version(%s)', (version_id,))
	db.execute("UPDATE audit.check_versions SET mode='review_uncertain' WHERE id=%s", (version_id,))
	as_admin(db)
	agreed, disagreed, unsure = (create_dataset(db, create_user(db)) for _ in range(3))
	for dataset, answers in ((agreed, ('ok', 'ok')), (disagreed, ('ok', 'major')), (unsure, ('unsure', 'ok'))):
		run = create_run(db, dataset, version_id)
		for model, verdict in zip(('luna-medium', 'haiku-5.5'), answers):
			model_row(db, dataset, run, None, verdict, model=model, layer='image')

	act_as(db, auditor)
	assert queue(db, agreed) == [('image', 'v1', 'ok', False, None, False)]
	assert queue(db, disagreed) == [('image', 'v1', 'major', True, 'models_disagree', False)]
	assert queue(db, unsure) == [('image', 'v1', 'unsure', True, 'unsure', False)]
	# a person's answer takes it off the list; an imported old audit does not
	import_legacy(db, auditor, unsure, 'ok', layer='image')
	person_row(db, auditor, disagreed, None, 'ok', layer='image')  # no run: not a review of these results
	act_as(db, auditor)
	assert queue(db, disagreed) == [('image', 'v1', 'major', True, 'models_disagree', False)]
	disagreed_run = db.execute('SELECT run_id FROM audit.current_runs WHERE dataset_id=%s', (disagreed,)).fetchone()[0]
	person_row(db, auditor, disagreed, None, 'ok', disagreed_run, layer='image')
	act_as(db, auditor)
	# the review on the run counts; the person's answer is not an automated result
	assert queue(db, disagreed) == [('image', 'v1', 'major', False, 'models_disagree', True)]
	assert db.execute(
		"SELECT count(*) FROM audit.current_assessments WHERE dataset_id=%s AND assessor_kind='person'", (disagreed,)
	).fetchone() == (0,)
	assert queue(db, unsure) == [('image', 'v1', 'unsure', True, 'unsure', False)]

	# auto_apply leaves only the spot-check sample
	everything = register_version(db, version='v2', spot_check_pct=100)
	nothing = register_version(db, version='v3', spot_check_pct=0)
	for version, expected in ((everything, 'spot_check'), (nothing, None)):
		act_as(db, operator)
		db.execute("UPDATE audit.check_versions SET mode='auto_apply' WHERE id=%s", (version,))
		as_admin(db)
		dataset = create_dataset(db, create_user(db))
		model_row(db, dataset, create_run(db, dataset, version), None, 'ok', layer='image')
		act_as(db, auditor)
		assert [(r[4], r[3]) for r in queue(db, dataset)] == [(expected, expected is not None)]


def test_a_review_holds_for_the_same_evidence_and_reopens_for_a_new_ortho(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	version_id = register_version(db)

	def run_on(inputs, source=None, version=version_id, rule=None):
		as_worker(db)
		run = db.execute(
			'INSERT INTO audit.runs(check_key,check_version_id,dataset_id,queue,status,finished_at,source_run_id,inputs) '
			"VALUES ('prediction_quality',%s,%s,'upload','done',now(),%s,%s) RETURNING id",
			(version, dataset, source, json.dumps(inputs)),
		).fetchone()[0]
		db.execute(
			"INSERT INTO audit.current_runs(dataset_id,check_key,run_id) VALUES (%s,'prediction_quality',%s) "
			'ON CONFLICT (dataset_id,check_key) DO UPDATE SET run_id=excluded.run_id',
			(dataset, run),
		)
		if rule:
			model_row(db, dataset, run, None, 'major', model='pq-dataset-rule', kind='rule', version=rule)
		else:
			model_row(db, dataset, run, None, 'major', layer='deadwood')
		return run

	ortho_a = {'ortho_sha256': 'a' * 64, 'labels': [42]}
	first = run_on(ortho_a)
	person_row(db, auditor, dataset, None, 'ok', first)
	act_as(db, auditor)
	assert queue(db, dataset)[0][3:] == (False, 'review_all', True)
	# a rule-only recomputation and a new prompt on the same inputs keep the review
	run_on({}, source=first, version=register_version(db, version='v2'), rule='v2')
	act_as(db, auditor)
	assert queue(db, dataset)[0][3:] == (False, 'review_all', True)
	run_on(ortho_a, version=register_version(db, version='v3'))
	act_as(db, auditor)
	assert queue(db, dataset)[0][3:] == (False, 'review_all', True)
	# a replaced ortho reopens it
	run_on({'ortho_sha256': 'b' * 64, 'labels': [43]})
	act_as(db, auditor)
	assert queue(db, dataset)[0][3:] == (True, 'review_all', False)


def test_operators_activate_a_version_and_can_keep_its_mode(db):
	operator, auditor = create_operator(db), create_user(db, can_audit=True)
	first, second, third = (register_version(db, version=v) for v in ('v1', 'v2', 'v3'))
	act_as(db, operator)
	db.execute('SELECT audit.activate_version(%s)', (first,))
	db.execute("UPDATE audit.check_versions SET mode='review_uncertain' WHERE id=%s", (first,))
	act_as(db, auditor)
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute('SELECT audit.activate_version(%s, true)', (second,))
	act_as(db, operator)
	assert db.execute('SELECT version,mode,is_active FROM audit.activate_version(%s, true)', (second,)).fetchone() == (
		'v2',
		'review_uncertain',
		True,
	)
	assert db.execute(
		'SELECT version FROM audit.check_versions WHERE id=ANY(%s) AND is_active', ([first, second, third],)
	).fetchall() == [('v2',)]
	# without inheriting, a new version keeps its own review_all
	assert db.execute('SELECT mode FROM audit.activate_version(%s)', (third,)).fetchone() == ('review_all',)


def test_the_hash_split_holds_one_in_five_out_and_never_moves(db):
	assert db.execute(
		"SELECT count(*) FILTER (WHERE audit.benchmark_split(g)='holdout') FROM generate_series(1,5000) g"
	).fetchone()[0] in range(900, 1100)
	assert db.execute('SELECT audit.benchmark_split(14747), audit.benchmark_split(14747)').fetchone() in {
		('dev', 'dev'),
		('holdout', 'holdout'),
	}


def create_benchmark(db, operator, name='pq-gold-dt1272'):
	act_as(db, operator)
	benchmark = db.execute(
		"INSERT INTO audit.benchmarks(check_key,name,version) VALUES ('prediction_quality',%s,'v1') RETURNING id",
		(name,),
	).fetchone()[0]
	as_admin(db)
	return benchmark


def test_operators_freeze_a_benchmark_and_its_members_stay_put(db):
	operator, auditor = create_operator(db), create_user(db, can_audit=True)
	dataset, other, late = (create_dataset(db, create_user(db)) for _ in range(3))
	gold = create_off_grid_crop(db, dataset)
	benchmark = create_benchmark(db, operator)
	hashed = db.execute('SELECT audit.benchmark_split(%s)', (dataset,)).fetchone()[0]
	frozen_earlier = 'dev' if hashed == 'holdout' else 'holdout'

	act_as(db, auditor)
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute('INSERT INTO audit.benchmark_members(benchmark_id,dataset_id) VALUES (%s,%s)', (benchmark, other))
	act_as(db, operator)
	# the split defaults to the hash; a split frozen earlier (DT-1272) is given explicitly
	db.execute('INSERT INTO audit.benchmark_members(benchmark_id,dataset_id) VALUES (%s,%s)', (benchmark, other))
	db.execute(
		'INSERT INTO audit.benchmark_members(benchmark_id,dataset_id,crop_id,split) VALUES (%s,%s,%s,%s)',
		(benchmark, dataset, gold, frozen_earlier),
	)
	assert db.execute(
		'SELECT split FROM audit.benchmark_members WHERE benchmark_id=%s AND dataset_id=%s', (benchmark, other)
	).fetchone() == (db.execute('SELECT audit.benchmark_split(%s)', (other,)).fetchone()[0],)
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		# a dataset never sits on both sides
		db.execute(
			'INSERT INTO audit.benchmark_members(benchmark_id,dataset_id,split) VALUES (%s,%s,%s)',
			(benchmark, dataset, hashed),
		)
	version_id = register_version(db)
	act_as(db, operator)
	with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState), db.transaction():
		db.execute(
			'INSERT INTO audit.benchmark_scores(benchmark_id,check_key,check_version_id,split,metrics,scorer) '
			"VALUES (%s,'prediction_quality',%s,'holdout','{}','eval_gold.py/v1')",
			(benchmark, version_id),
		)
	db.execute('UPDATE audit.benchmarks SET frozen_at=now() WHERE id=%s', (benchmark,))
	for statement, args in (
		('INSERT INTO audit.benchmark_members(benchmark_id,dataset_id) VALUES (%s,%s)', (benchmark, late)),
		('DELETE FROM audit.benchmark_members WHERE benchmark_id=%s AND dataset_id=%s', (benchmark, other)),
		("UPDATE audit.benchmarks SET description='bigger' WHERE id=%s", (benchmark,)),
		('DELETE FROM audit.benchmarks WHERE id=%s', (benchmark,)),
	):
		with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState), db.transaction():
			db.execute(statement, args)

	# the worker records scores on the frozen benchmark; they never change
	as_worker(db)
	run = db.execute(
		'INSERT INTO audit.runs(check_key,check_version_id,dataset_id,queue) '
		"VALUES ('prediction_quality',%s,%s,'benchmark') RETURNING id",
		(version_id, dataset),
	).fetchone()[0]
	db.execute(
		'INSERT INTO audit.benchmark_scores(benchmark_id,check_key,check_version_id,split,metrics,run_ids,scorer) '
		"VALUES (%s,'prediction_quality',%s,'holdout','{\"n\": 2, \"auc\": 0.93}',%s,'eval_gold.py/v1')",
		(benchmark, version_id, [run]),
	)
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		# a benchmark run never moves the current pointer
		db.execute(
			"INSERT INTO audit.current_runs(dataset_id,check_key,run_id) VALUES (%s,'prediction_quality',%s)",
			(dataset, run),
		)
	with pytest.raises(psycopg.errors.ForeignKeyViolation), db.transaction():
		# a score belongs to a version of the benchmark's own check
		db.execute(
			'INSERT INTO audit.benchmark_scores(benchmark_id,check_key,check_version_id,split,metrics,scorer) '
			"VALUES (%s,'georef',%s,'holdout','{}','eval_gold.py/v1')",
			(benchmark, version_id),
		)
	as_admin(db)
	with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState), db.transaction():
		db.execute("UPDATE audit.benchmark_scores SET notes='x' WHERE benchmark_id=%s", (benchmark,))
	# a deleted dataset still leaves a frozen benchmark
	db.execute('DELETE FROM public.v2_datasets WHERE id=%s', (other,))
	assert db.execute(
		'SELECT count(*) FROM audit.benchmark_members WHERE benchmark_id=%s', (benchmark,)
	).fetchone() == (1,)


def test_crops_made_off_the_grid_keep_their_own_footprint_and_size(db):
	dataset = create_dataset(db, create_user(db))
	crop = create_off_grid_crop(db, dataset)
	as_worker(db)
	with pytest.raises(psycopg.errors.UniqueViolation), db.transaction():
		create_off_grid_crop(db, dataset)
	as_worker(db)
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		db.execute(
			'INSERT INTO audit.crops(dataset_id,ortho_sha256,crop_sets,pixel_x0,geometry,mpp,size_px) '
			"VALUES (%s,%s,'{benchmark}',5,%s,0.036,1400)",
			(dataset, SHA, SQUARE),
		)
	as_admin(db)
	assert db.execute('SELECT mpp,size_px,pixel_x0 FROM audit.crops WHERE id=%s', (crop,)).fetchone() == (
		pytest.approx(0.036),
		1400,
		None,
	)


def test_a_check_owned_definer_function_can_store_a_run_in_one_call(db):
	"""Checks may store a run, its pointer and model rows through their own SECURITY DEFINER function."""
	dataset = create_dataset(db, create_user(db))
	version_id = register_version(db, check='georef')
	db.execute("""
		CREATE FUNCTION public.audit_store_probe(p_dataset bigint, p_version bigint) RETURNS bigint
		LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
		DECLARE v_run bigint;
		BEGIN
			IF NOT internal.is_audit_worker() THEN
				RAISE EXCEPTION 'worker only' USING errcode = '42501';
			END IF;
			INSERT INTO audit.runs(check_key,check_version_id,dataset_id,queue,status,finished_at)
			VALUES ('georef',p_version,p_dataset,'upload','done',now()) RETURNING id INTO v_run;
			INSERT INTO audit.current_runs(dataset_id,check_key,run_id) VALUES (p_dataset,'georef',v_run);
			INSERT INTO audit.assessments(check_key,dataset_id,run_id,layer,assessor_kind,model,prompt_version,verdict,details)
			VALUES ('georef',p_dataset,v_run,'georef','model','romav2.0.1','georef-rules-v1','ok','{"p90_m": 2.7}');
			RETURN v_run;
		END $$;
		GRANT EXECUTE ON FUNCTION public.audit_store_probe(bigint, bigint) TO authenticated;
	""")
	auditor = create_user(db, can_audit=True)
	act_as(db, auditor)
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute('SELECT public.audit_store_probe(%s,%s)', (dataset, version_id))
	as_worker(db)
	run = db.execute('SELECT public.audit_store_probe(%s,%s)', (dataset, version_id)).fetchone()[0]
	assert db.execute(
		"SELECT run_id FROM audit.current_runs WHERE dataset_id=%s AND check_key='georef'", (dataset,)
	).fetchone() == (run,)


def test_analyst_reads_every_audit_table_and_view_without_writing(db):
	dataset = create_dataset(db, create_user(db), access='private')
	run = create_run(db, dataset, register_version(db))
	model_row(db, dataset, run, create_crop(db, dataset), 'major')
	db.execute('SET SESSION AUTHORIZATION team_analyst')
	for table in (
		'checks',
		'check_versions',
		'runs',
		'current_runs',
		'crops',
		'images',
		'assessments',
		'benchmarks',
		'benchmark_members',
		'benchmark_scores',
		'latest_assessments',
		'current_assessments',
		'disagreements',
		'review_queue',
	):
		db.execute(f'SELECT * FROM audit.{table} LIMIT 1').fetchall()
	assert count(db, 'assessments', dataset) == 1
	assert db.execute('SELECT audit.benchmark_split(%s)', (dataset,)).fetchone()[0] in ('dev', 'holdout')
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute('DELETE FROM audit.assessments WHERE dataset_id=%s', (dataset,))


DOWN = """
DROP VIEW audit.review_queue;
DROP VIEW audit.disagreements;
DROP VIEW audit.current_assessments;
DROP VIEW audit.latest_assessments;
DROP FUNCTION audit.activate_version(bigint, boolean);
DROP TABLE audit.benchmark_scores, audit.benchmark_members, audit.benchmarks,
	audit.assessments, audit.images, audit.crops, audit.current_runs,
	audit.runs, audit.check_versions, audit.checks;
DROP FUNCTION audit.benchmark_split(bigint), internal.can_read_audit_checks(), internal.is_audit_worker(),
	internal.reject_audit_row_update(), internal.stamp_audit_check_version(), internal.append_only_audit_crop_sets(),
	internal.reject_benchmark_current_run(), internal.guard_audit_benchmark(),
	internal.guard_audit_benchmark_member(), internal.require_frozen_audit_benchmark(),
	internal.check_audit_rule_only_run(), internal.reject_model_rows_on_rule_only_runs();
DROP TYPE audit.check_mode, audit.run_status, audit.assessor_kind, audit.verdict;
DROP SCHEMA audit;
"""


def test_the_migration_can_be_reverted_without_touching_other_objects(db):
	"""Nothing outside the framework depends on it, so the down path is a plain drop without CASCADE."""
	db.execute(DOWN)
	assert db.execute(
		"SELECT to_regnamespace('audit'), to_regtype('audit.verdict'), to_regprocedure('internal.is_audit_worker()')"
	).fetchone() == (None, None, None)
	# objects that existed before the migration are untouched
	assert db.execute("SELECT to_regclass('public.audit_review_queue') IS NOT NULL").fetchone() == (True,)
