"""Acquisition-date estimates, audit suggestions and the accept-suggested-date trigger."""
import json
import uuid
from urllib.parse import urlparse

import psycopg
import pytest

from shared.settings import settings

PROCESSOR_EMAIL = 'processor@deadtrees.earth'


@pytest.fixture
def db():
	assert urlparse(settings.SUPABASE_DB_URL).hostname in {'localhost', '127.0.0.1', 'host.docker.internal'}, 'Local database required'
	with psycopg.connect(settings.SUPABASE_DB_URL, user='supabase_admin') as conn:
		try:
			yield conn
		finally:
			conn.rollback()


def create_user(db, can_audit=False):
	user = uuid.uuid4()
	db.execute('INSERT INTO auth.users(id,email) VALUES (%s,%s)', (user, f'{user}@example.invalid'))
	if can_audit:
		db.execute('INSERT INTO public.privileged_users(user_id,can_audit) VALUES (%s,true)', (user,))
	return user


def create_dataset(db, owner, date=(2022, 3, 11), access='public'):
	return db.execute(
		'INSERT INTO public.v2_datasets(user_id,file_name,license,platform,data_access,aquisition_year,aquisition_month,aquisition_day) '
		"VALUES (%s,'doy.tif','CC BY','drone',%s,%s,%s,%s) RETURNING id",
		(owner, access, *date),
	).fetchone()[0]


def add_estimate(db, dataset, recorded=(2022, 3, 11), suggested='2022-07-19'):
	db.execute(
		'INSERT INTO public.v2_acquisition_date_estimates(dataset_id,model_version,model_type,probabilities,flight_year,'
		'recorded_year,recorded_month,recorded_day,recorded_precision,predicted_date,mode_date,hdi,hdi80_days,n_modes,'
		'is_mismatch,suggested_date,suggestion_reason,recommend_accept) '
		"VALUES (%s,'doy_estimation_v1','s2',%s,2022,%s,%s,%s,'day','2022-07-19','2022-07-18','{}',26,1,%s,%s,%s,true)",
		(dataset, [1 / 365] * 365, *recorded, suggested is not None, suggested, 'mismatch' if suggested else None),
	)


def act_as(db, user, email=None):
	db.execute('RESET ROLE')
	db.execute('SET LOCAL ROLE authenticated')
	claims = {'sub': str(user), 'role': 'authenticated', **({'email': email} if email else {})}
	db.execute("SELECT set_config('request.jwt.claims',%s,true)", (json.dumps(claims),))
	db.execute("SELECT set_config('request.headers','{}',true)")


def act_as_anon(db):
	db.execute('RESET ROLE')
	db.execute('SET LOCAL ROLE anon')
	db.execute("SELECT set_config('request.jwt.claims','{\"role\":\"anon\"}',true)")


def dataset_date(db, dataset):
	db.execute('RESET ROLE')
	return db.execute('SELECT aquisition_year,aquisition_month,aquisition_day FROM public.v2_datasets WHERE id=%s', (dataset,)).fetchone()


def test_accepting_the_suggestion_sets_the_date_and_reverting_restores_it(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	add_estimate(db, dataset)

	act_as(db, auditor)
	db.execute(
		'INSERT INTO public.dataset_audit(dataset_id,audited_by,has_valid_acquisition_date,accept_suggested_acquisition_date) VALUES (%s,%s,false,true)',
		(dataset, auditor),
	)
	assert dataset_date(db, dataset) == (2022, 7, 19)
	original, applied = db.execute(
		'SELECT original_acquisition_date,applied_acquisition_date FROM public.dataset_audit WHERE dataset_id=%s', (dataset,)
	).fetchone()
	assert original == {'year': 2022, 'month': 3, 'day': 11}
	assert applied['model_version'] == 'doy_estimation_v1' and (applied['month'], applied['day']) == (7, 19)
	history = db.execute(
		'SELECT field_name,user_id FROM public.v2_dataset_edit_history WHERE dataset_id=%s ORDER BY id', (dataset,)
	).fetchall()
	assert {f for f, _ in history} == {'aquisition_month', 'aquisition_day'} and {u for _, u in history} == {auditor}

	act_as(db, auditor)
	db.execute('UPDATE public.dataset_audit SET accept_suggested_acquisition_date=false WHERE dataset_id=%s', (dataset,))
	assert dataset_date(db, dataset) == (2022, 3, 11)
	assert db.execute('SELECT original_acquisition_date FROM public.dataset_audit WHERE dataset_id=%s', (dataset,)).fetchone() == (None,)


def test_accepting_needs_a_suggestion_for_the_current_date(db):
	auditor = create_user(db, can_audit=True)
	no_suggestion = create_dataset(db, create_user(db))
	add_estimate(db, no_suggestion, suggested=None)
	act_as(db, auditor)
	with pytest.raises(psycopg.errors.CheckViolation):
		db.execute('INSERT INTO public.dataset_audit(dataset_id,audited_by,accept_suggested_acquisition_date) VALUES (%s,%s,true)', (no_suggestion, auditor))
	db.rollback()

	auditor = create_user(db, can_audit=True)
	changed = create_dataset(db, create_user(db), date=(2022, 5, 1))
	add_estimate(db, changed, recorded=(2022, 3, 11))
	act_as(db, auditor)
	with pytest.raises(psycopg.errors.SerializationFailure):
		db.execute('INSERT INTO public.dataset_audit(dataset_id,audited_by,accept_suggested_acquisition_date) VALUES (%s,%s,true)', (changed, auditor))


def test_suggestions_are_auditor_only_and_written_by_the_processor(db):
	auditor, viewer = create_user(db, can_audit=True), create_user(db)
	processor = db.execute('SELECT id FROM auth.users WHERE email=%s', (PROCESSOR_EMAIL,)).fetchone()
	processor = processor[0] if processor else create_user(db)
	dataset = create_dataset(db, create_user(db))

	act_as(db, processor, email=PROCESSOR_EMAIL)
	db.execute(
		"INSERT INTO public.dataset_audit_suggestions(dataset_id,field,value,source) VALUES (%s,'has_valid_acquisition_date','false','doy_estimation_v1')",
		(dataset,),
	)
	act_as(db, auditor)
	assert db.execute('SELECT count(*) FROM public.dataset_audit_suggestions WHERE dataset_id=%s', (dataset,)).fetchone() == (1,)
	act_as(db, viewer)
	assert db.execute('SELECT count(*) FROM public.dataset_audit_suggestions WHERE dataset_id=%s', (dataset,)).fetchone() == (0,)
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute(
			"INSERT INTO public.dataset_audit_suggestions(dataset_id,field,value,source) VALUES (%s,'notes','\"x\"','manual')", (dataset,)
		)


def test_estimates_follow_dataset_visibility(db):
	public = create_dataset(db, create_user(db))
	private = create_dataset(db, create_user(db), access='private')
	add_estimate(db, public)
	add_estimate(db, private)
	act_as_anon(db)
	visible = {r[0] for r in db.execute('SELECT dataset_id FROM public.v2_acquisition_date_estimates WHERE dataset_id IN (%s,%s)', (public, private))}
	assert visible == {public}


def test_audit_rpc_and_conflicts_view_expose_the_saved_decision(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	add_estimate(db, dataset)
	db.execute(
		"INSERT INTO public.dataset_audit_suggestions(dataset_id,field,value,source) VALUES (%s,'has_valid_acquisition_date','false','doy_estimation_v1')",
		(dataset,),
	)
	act_as(db, auditor)
	db.execute(
		"INSERT INTO public.dataset_audit(dataset_id,audited_by,has_valid_acquisition_date,accept_suggested_acquisition_date,audit_date) "
		"VALUES (%s,%s,true,false,now() - interval '1 day')",
		(dataset, auditor),
	)
	row = db.execute(
		'SELECT accept_suggested_acquisition_date FROM public.get_dataset_audit_with_emails(%s)', (dataset,)
	).fetchone()
	assert row == (False,)
	conflicts = db.execute(
		'SELECT field,suggested_value,audited_value,suggested_after_audit FROM public.dataset_audit_suggestion_conflicts WHERE dataset_id=%s',
		(dataset,),
	).fetchall()
	assert conflicts == [('has_valid_acquisition_date', False, True, True)]
