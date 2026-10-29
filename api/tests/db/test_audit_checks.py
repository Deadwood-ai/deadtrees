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


def register_version(db, check='prediction_quality', version='v1'):
	as_worker(db)
	version_id = db.execute(
		'INSERT INTO public.audit_check_versions(check_key,version,config) VALUES (%s,%s,%s) RETURNING id',
		(check, version, json.dumps({'models': ['luna-medium', 'haiku-5.5'], 'prompt_version': 'v4'})),
	).fetchone()[0]
	as_admin(db)
	return version_id


def create_run(db, dataset, version_id, check='prediction_quality', current=True):
	as_worker(db)
	run = db.execute(
		'INSERT INTO public.audit_check_runs(check_key,check_version_id,dataset_id,queue,status,started_at,finished_at) '
		"VALUES (%s,%s,%s,'upload','done',now(),now()) RETURNING id",
		(check, version_id, dataset),
	).fetchone()[0]
	if current:
		db.execute(
			'INSERT INTO public.audit_current_runs(dataset_id,check_key,run_id) VALUES (%s,%s,%s) '
			'ON CONFLICT (dataset_id,check_key) DO UPDATE SET run_id=excluded.run_id,updated_at=now()',
			(dataset, check, run),
		)
	as_admin(db)
	return run


def create_crop(db, dataset, sets=('exclude',), x0=0):
	as_worker(db)
	crop = db.execute(
		'INSERT INTO public.audit_crops(dataset_id,ortho_sha256,crop_sets,pixel_x0,pixel_y0,pixel_x1,pixel_y1,geometry,mpp,size_px,selection) '
		'VALUES (%s,%s,%s,%s,0,%s,512,%s,0.05,1024,%s) RETURNING id',
		(dataset, SHA, list(sets), x0, x0 + 512, SQUARE, json.dumps({s: {'picker': 'top-cover-v1'} for s in sets})),
	).fetchone()[0]
	as_admin(db)
	return crop


def model_row(db, dataset, run, crop, verdict, model='luna-medium', kind='model', layer='deadwood'):
	as_worker(db)
	db.execute(
		'INSERT INTO public.audit_assessments(check_key,dataset_id,crop_id,run_id,layer,label_id,assessor_kind,model,prompt_version,'
		"verdict,major_likelihood,modes,raw) VALUES ('prediction_quality',%s,%s,%s,%s,42,%s,%s,'v4',%s,70,%s,%s)",
		(
			dataset,
			crop,
			run,
			layer,
			kind,
			model,
			verdict,
			json.dumps({'m1_dead_missed': {'likelihood': 80, 'area_pct': 12}}),
			json.dumps({'text': 'reply'}),
		),
	)
	as_admin(db)


def person_row(db, auditor, dataset, crop, verdict, run=None, layer='deadwood'):
	act_as(db, auditor)
	db.execute(
		'INSERT INTO public.audit_assessments(check_key,dataset_id,crop_id,run_id,layer,assessor_kind,assessor_user_id,verdict,modes) '
		"VALUES ('prediction_quality',%s,%s,%s,%s,'person',%s,%s,%s)",
		(dataset, crop, run, layer, auditor, verdict, json.dumps({'m1_dead_missed': True})),
	)
	as_admin(db)


def count(db, table, dataset):
	return db.execute(f'SELECT count(*) FROM public.{table} WHERE dataset_id=%s', (dataset,)).fetchone()[0]


def test_the_worker_registers_versions_and_only_operators_switch_mode_and_activate(db):
	version_id = register_version(db)
	as_worker(db)
	for mode, active in (('auto_apply', False), ('review_all', True)):
		with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
			db.execute(
				"INSERT INTO public.audit_check_versions(check_key,version,mode,is_active) VALUES ('georef','v9',%s,%s)",
				(mode, active),
			)
	assert (
		db.execute("UPDATE public.audit_check_versions SET mode='auto_apply' WHERE id=%s", (version_id,)).rowcount == 0
	)

	as_admin(db)
	operator = create_operator(db)
	act_as(db, operator)
	db.execute(
		"UPDATE public.audit_check_versions SET mode='review_uncertain',is_active=true WHERE id=%s", (version_id,)
	)
	assert db.execute(
		'SELECT mode,is_active,updated_by FROM public.audit_check_versions WHERE id=%s', (version_id,)
	).fetchone() == ('review_uncertain', True, operator)
	# config and version belong to the registered version; a change is a new version
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute("UPDATE public.audit_check_versions SET config='{}' WHERE id=%s", (version_id,))
	as_admin(db)
	with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState), db.transaction():
		db.execute("UPDATE public.audit_check_versions SET version='v1b' WHERE id=%s", (version_id,))
	# one active version per check
	second = register_version(db, version='v2')
	with pytest.raises(psycopg.errors.UniqueViolation), db.transaction():
		db.execute('UPDATE public.audit_check_versions SET is_active=true WHERE id=%s', (second,))


def test_worker_writes_evidence_and_model_rows_that_only_auditors_see(db):
	owner = create_user(db)
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, owner, access='private')
	run = create_run(db, dataset, register_version(db))
	crop = create_crop(db, dataset)
	as_worker(db)
	db.execute(
		'INSERT INTO public.audit_images(dataset_id,ortho_sha256,crop_id,kind,storage_path,content_type,width,height) '
		"VALUES (%s,%s,%s,'raw','audit/crops/1/raw.jpg','image/jpeg',1024,1024),"
		"(%s,%s,%s,'overview','audit/overviews/1.jpg','image/jpeg',2048,1600)",
		(dataset, SHA, crop, dataset, SHA, None),
	)
	db.execute(
		'INSERT INTO public.audit_images(dataset_id,ortho_sha256,crop_id,label_id,kind,storage_path,content_type,width,height) '
		"VALUES (%s,%s,%s,42,'deadwood_overlay','audit/crops/1/deadwood-42.png','image/png',1024,1024)",
		(dataset, SHA, crop),
	)
	with pytest.raises(psycopg.errors.UniqueViolation), db.transaction():
		# the raw crop is stored once per ortho
		db.execute(
			'INSERT INTO public.audit_images(dataset_id,ortho_sha256,crop_id,kind,storage_path,content_type,width,height) '
			"VALUES (%s,%s,%s,'raw','audit/crops/1/raw-2.jpg','image/jpeg',1024,1024)",
			(dataset, SHA, crop),
		)
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		db.execute(
			'INSERT INTO public.audit_images(dataset_id,ortho_sha256,kind,storage_path,content_type,width,height) '
			"VALUES (%s,%s,'thumbnail','../etc/passwd','image/jpeg',10,10)",
			(dataset, SHA),
		)
	as_admin(db)
	model_row(db, dataset, run, crop, 'major')
	model_row(db, dataset, run, crop, 'ok', model='band_check', kind='rule', layer='image')

	tables = ('audit_check_runs', 'audit_current_runs', 'audit_crops', 'audit_images', 'audit_assessments')
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
			"INSERT INTO public.audit_check_runs(check_key,check_version_id,dataset_id,queue) VALUES ('prediction_quality',%s,%s,'manual')",
			(1, dataset),
		)
	# auditors cannot write model rows
	act_as(db, auditor)
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute(
			'INSERT INTO public.audit_assessments(check_key,dataset_id,run_id,layer,assessor_kind,model,prompt_version,verdict) '
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
			'INSERT INTO public.audit_assessments(check_key,dataset_id,layer,assessor_kind,assessor_user_id,verdict) '
			"VALUES ('georef',%s,'georef','person',%s,'major')",
			(dataset, other),
		)
	for statement in ("UPDATE public.audit_assessments SET verdict='ok'", 'DELETE FROM public.audit_assessments'):
		with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
			db.execute(statement + ' WHERE dataset_id=%s', (dataset,))
	as_admin(db)
	with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState), db.transaction():
		db.execute("UPDATE public.audit_assessments SET verdict='ok' WHERE dataset_id=%s", (dataset,))
	# a person row cannot carry model fields, a model row needs its run
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		db.execute(
			'INSERT INTO public.audit_assessments(check_key,dataset_id,layer,assessor_kind,assessor_user_id,model,verdict) '
			"VALUES ('georef',%s,'georef','person',%s,'luna-medium','ok')",
			(dataset, auditor),
		)
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		db.execute(
			'INSERT INTO public.audit_assessments(check_key,dataset_id,layer,assessor_kind,model,prompt_version,verdict) '
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
				'INSERT INTO public.audit_assessments(check_key,dataset_id,crop_id,run_id,layer,assessor_kind,assessor_user_id,verdict) '
				"VALUES (%s,%s,%s,%s,'deadwood','person',%s,'ok')",
				(check, dataset, crop_id, run_id, auditor),
			)
	as_worker(db)
	with pytest.raises(psycopg.errors.ForeignKeyViolation), db.transaction():
		db.execute(
			"INSERT INTO public.audit_check_runs(check_key,check_version_id,dataset_id,queue) VALUES ('georef',%s,%s,'backfill')",
			(version_id, first),
		)
	with pytest.raises(psycopg.errors.CheckViolation), db.transaction():
		# a finished run carries its finish time, a failed run its error
		db.execute(
			'INSERT INTO public.audit_check_runs(check_key,check_version_id,dataset_id,queue,status,finished_at) '
			"VALUES ('prediction_quality',%s,%s,'backfill','failed',now())",
			(version_id, first),
		)


def test_a_crop_joins_more_sets_but_keeps_its_window(db):
	dataset = create_dataset(db, create_user(db))
	crop = create_crop(db, dataset)
	as_worker(db)
	db.execute(
		"UPDATE public.audit_crops SET crop_sets=crop_sets || '{training}', "
		'selection=selection || \'{"training": {"picker": "s2-stratified-v1", "stratum": 3}}\' WHERE id=%s',
		(crop,),
	)
	assert db.execute('SELECT crop_sets FROM public.audit_crops WHERE id=%s', (crop,)).fetchone() == (
		['exclude', 'training'],
	)
	with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState), db.transaction():
		db.execute("UPDATE public.audit_crops SET crop_sets='{training}' WHERE id=%s", (crop,))
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute('UPDATE public.audit_crops SET pixel_x0=1 WHERE id=%s', (crop,))
	with pytest.raises(psycopg.errors.UniqueViolation), db.transaction():
		db.execute(
			'INSERT INTO public.audit_crops(dataset_id,ortho_sha256,crop_sets,pixel_x0,pixel_y0,pixel_x1,pixel_y1,geometry,mpp,size_px) '
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
		'SELECT assessor,verdict FROM public.audit_latest_assessments WHERE crop_id=%s ORDER BY assessor', (crop,)
	).fetchall()
	assert sorted(latest) == sorted(
		[(str(janusch), 'major'), (str(clemens), 'minor'), ('haiku-5.5/v4', 'ok'), ('luna-medium/v4', 'major')]
	)
	assert db.execute(
		'SELECT crop_id,people_disagree,people_and_models_disagree,verdicts FROM public.audit_disagreements WHERE dataset_id=%s',
		(dataset,),
	).fetchall() == [(crop, True, True, {str(janusch): 'major', str(clemens): 'minor', 'luna-medium/v4': 'major'})]
	# the earlier run's model answer stays in the table but no longer counts
	assert db.execute('SELECT count(*) FROM public.audit_assessments WHERE run_id=%s', (old_run,)).fetchone() == (1,)


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
	assert db.execute('SELECT verdicts FROM public.audit_disagreements WHERE crop_id=%s', (crop,)).fetchall() == [
		({str(auditor): 'ok', 'luna-medium/v4': 'major'},)
	]


def test_api_roles_get_only_the_privileges_the_policies_use(db):
	tables = (
		'audit_checks',
		'audit_check_versions',
		'audit_check_runs',
		'audit_current_runs',
		'audit_crops',
		'audit_images',
		'audit_assessments',
		'audit_benchmark_pins',
		'audit_latest_assessments',
		'audit_disagreements',
	)
	granted = {
		(role, table): set(privileges)
		for role, table, privileges in db.execute(
			'SELECT grantee,table_name,array_agg(privilege_type::text) FROM information_schema.role_table_grants '
			"WHERE table_schema='public' AND table_name=ANY(%s) AND grantee IN ('anon','authenticated') GROUP BY 1,2",
			(list(tables),),
		)
	}
	writes = {
		'audit_check_versions': {'INSERT'},
		'audit_check_runs': {'INSERT'},
		'audit_current_runs': {'INSERT', 'UPDATE', 'DELETE'},
		'audit_crops': {'INSERT'},
		'audit_images': {'INSERT'},
		'audit_assessments': {'INSERT'},
	}
	assert granted == {('authenticated', t): {'SELECT'} | writes.get(t, set()) for t in tables}
	# the remaining updates are column grants: run state, crop sets, version mode
	assert db.execute(
		"SELECT has_column_privilege('authenticated','public.audit_crops','pixel_x0','UPDATE'), "
		"has_column_privilege('authenticated','public.audit_crops','crop_sets','UPDATE'), "
		"has_column_privilege('authenticated','public.audit_check_versions','config','UPDATE')"
	).fetchone() == (False, True, False)


def test_benchmark_split_is_fixed_by_hash_or_pin(db):
	dataset = create_dataset(db, create_user(db))
	auditor = create_user(db, can_audit=True)
	assert db.execute(
		"SELECT count(*) FILTER (WHERE public.audit_benchmark_split(g)='holdout') FROM generate_series(1,5000) g"
	).fetchone()[0] in range(900, 1100)
	hashed = db.execute('SELECT public.audit_benchmark_split(%s)', (dataset,)).fetchone()[0]
	pinned = 'dev' if hashed == 'holdout' else 'holdout'
	db.execute(
		"INSERT INTO public.audit_benchmark_pins(dataset_id,split,reason) VALUES (%s,%s,'dt-1272-gold')",
		(dataset, pinned),
	)
	act_as(db, auditor)
	assert db.execute('SELECT public.audit_benchmark_split(%s)', (dataset,)).fetchone() == (pinned,)
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute("INSERT INTO public.audit_benchmark_pins(dataset_id,split,reason) VALUES (%s,'dev','x')", (dataset,))
	as_admin(db)
	with pytest.raises(psycopg.errors.ObjectNotInPrerequisiteState), db.transaction():
		db.execute('UPDATE public.audit_benchmark_pins SET split=%s WHERE dataset_id=%s', (hashed, dataset))


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
			INSERT INTO public.audit_check_runs(check_key,check_version_id,dataset_id,queue,status,finished_at)
			VALUES ('georef',p_version,p_dataset,'upload','done',now()) RETURNING id INTO v_run;
			INSERT INTO public.audit_current_runs(dataset_id,check_key,run_id) VALUES (p_dataset,'georef',v_run);
			INSERT INTO public.audit_assessments(check_key,dataset_id,run_id,layer,assessor_kind,model,prompt_version,verdict,details)
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
		"SELECT run_id FROM public.audit_current_runs WHERE dataset_id=%s AND check_key='georef'", (dataset,)
	).fetchone() == (run,)


def test_analyst_reads_every_audit_table_and_view_without_writing(db):
	dataset = create_dataset(db, create_user(db), access='private')
	run = create_run(db, dataset, register_version(db))
	model_row(db, dataset, run, create_crop(db, dataset), 'major')
	db.execute('SET SESSION AUTHORIZATION team_analyst')
	for table in (
		'audit_checks',
		'audit_check_versions',
		'audit_check_runs',
		'audit_current_runs',
		'audit_crops',
		'audit_images',
		'audit_assessments',
		'audit_benchmark_pins',
		'audit_latest_assessments',
		'audit_disagreements',
	):
		db.execute(f'SELECT * FROM public.{table} LIMIT 1').fetchall()
	assert count(db, 'audit_assessments', dataset) == 1
	assert db.execute('SELECT public.audit_benchmark_split(%s)', (dataset,)).fetchone()[0] in ('dev', 'holdout')
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute('DELETE FROM public.audit_assessments WHERE dataset_id=%s', (dataset,))


DOWN = """
DROP VIEW public.audit_disagreements;
DROP VIEW public.audit_latest_assessments;
DROP TABLE public.audit_assessments, public.audit_images, public.audit_crops, public.audit_current_runs,
	public.audit_check_runs, public.audit_check_versions, public.audit_checks, public.audit_benchmark_pins;
DROP FUNCTION public.audit_benchmark_split(bigint), internal.can_read_audit_checks(), internal.is_audit_worker(),
	internal.reject_audit_row_update(), internal.stamp_audit_check_version(), internal.append_only_audit_crop_sets();
DROP TYPE public.audit_check_mode, public.audit_run_status, public.audit_assessor_kind, public.audit_verdict;
"""


def test_the_migration_can_be_reverted_without_touching_other_objects(db):
	"""Nothing outside the framework depends on it, so the down path is a plain drop without CASCADE."""
	db.execute(DOWN)
	assert db.execute(
		"SELECT to_regclass('public.audit_assessments'), to_regtype('public.audit_verdict'), "
		"to_regprocedure('internal.is_audit_worker()')"
	).fetchone() == (None, None, None)
	# objects that existed before the migration are untouched
	assert db.execute("SELECT to_regclass('public.audit_review_queue') IS NOT NULL").fetchone() == (True,)
