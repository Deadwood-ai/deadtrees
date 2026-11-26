"""Acquisition-date estimates (AerialStamp) and the history of the old date decisions; shared DB test helpers."""
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


def processor_user(db):
	row = db.execute('SELECT id FROM auth.users WHERE email=%s', (PROCESSOR_EMAIL,)).fetchone()
	if row:
		return row[0]
	user = uuid.uuid4()
	db.execute('INSERT INTO auth.users(id,email) VALUES (%s,%s)', (user, PROCESSOR_EMAIL))
	return user


def create_dataset(db, owner, date=(2022, 3, 11), access='public'):
	return db.execute(
		'INSERT INTO public.v2_datasets(user_id,file_name,license,platform,data_access,aquisition_year,aquisition_month,aquisition_day) '
		"VALUES (%s,'doy.tif','CC BY','drone',%s,%s,%s,%s) RETURNING id",
		(owner, access, *date),
	).fetchone()[0]


def upsert_estimate(db, dataset, recorded=(2022, 3, 11), mismatch=True, suggested='2022-07-19', reason='mismatch', version='doy_estimation_v1'):
	as_admin(db)
	db.execute(
		'INSERT INTO public.v2_acquisition_date_estimates(dataset_id,model_version,model_type,probabilities,flight_year,'
		'recorded_year,recorded_month,recorded_day,recorded_precision,predicted_date,mode_date,hdi,hdi80_days,n_modes,'
		'recorded_offset_days,is_mismatch,suggested_date,suggestion_reason,recommend_accept) '
		"VALUES (%s,%s,'s2',%s,2022,%s,%s,%s,'day','2022-07-19','2022-07-18','{}',26,1,130,%s,%s,%s,true) "
		'ON CONFLICT (dataset_id) DO UPDATE SET model_version=excluded.model_version,recorded_year=excluded.recorded_year,'
		'recorded_month=excluded.recorded_month,recorded_day=excluded.recorded_day,is_mismatch=excluded.is_mismatch,'
		'suggested_date=excluded.suggested_date,suggestion_reason=excluded.suggestion_reason',
		(dataset, version, [1 / 365] * 365, *recorded, mismatch, suggested, reason if suggested else None),
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


def as_admin(db):
	db.execute('RESET ROLE')
	db.execute("SELECT set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)")


def dataset_row(db, dataset):
	as_admin(db)
	return db.execute(
		'SELECT aquisition_year,aquisition_month,aquisition_day,aquisition_date_source,aquisition_date_decision_id FROM public.v2_datasets WHERE id=%s',
		(dataset,),
	).fetchone()


def decisions(db, dataset):
	as_admin(db)
	return db.execute(
		'SELECT id,source,date_valid,suggestion_decision,superseded_reason FROM public.acquisition_date_decisions WHERE dataset_id=%s ORDER BY id',
		(dataset,),
	).fetchall()


def history_decision(db, dataset, valid=True):
	"""A decision of the old date check, kept as history."""
	as_admin(db)
	return db.execute(
		"INSERT INTO public.acquisition_date_decisions(dataset_id,source,date_valid) VALUES (%s,'legacy_audit',%s) RETURNING id",
		(dataset, valid),
	).fetchone()[0]


def test_estimates_neither_reopen_decisions_nor_change_the_dataset(db):
	dataset = create_dataset(db, create_user(db))
	history_decision(db, dataset)
	upsert_estimate(db, dataset, mismatch=False, suggested=None)
	upsert_estimate(db, dataset, mismatch=True, version='doy_estimation_v2')  # used to reopen the decision
	assert [r[4] for r in decisions(db, dataset)] == [None]
	assert dataset_row(db, dataset)[:4] == (2022, 3, 11, 'reported')
	assert db.execute(
		"SELECT count(*) FROM pg_trigger WHERE tgrelid='public.v2_acquisition_date_estimates'::regclass AND NOT tgisinternal"
	).fetchone() == (0,)
	for function in (
		'public.record_acquisition_date_decision(bigint,boolean,boolean,text,uuid)',
		'public.record_automatic_acquisition_date_decision(bigint)',
		'public.supersede_acquisition_date_decisions_before(timestamptz)',
		'public.supersede_acquisition_date_decision(bigint,text)',
	):
		assert db.execute('SELECT to_regprocedure(%s)', (function,)).fetchone() == (None,)


def test_a_hand_edit_makes_a_model_date_a_reported_date_again(db):
	dataset = create_dataset(db, create_user(db))
	decision = history_decision(db, dataset, valid=False)
	db.execute(
		"UPDATE public.v2_datasets SET aquisition_date_source='model_suggestion', aquisition_date_decision_id=%s WHERE id=%s",
		(decision, dataset),
	)
	db.execute('UPDATE public.v2_datasets SET aquisition_day=20 WHERE id=%s', (dataset,))
	assert dataset_row(db, dataset)[2:] == (20, 'reported', None)
	# the decision stays as it was
	assert [r[4] for r in decisions(db, dataset)] == [None]


def test_read_access_follows_roles_and_visibility(db):
	auditor = create_user(db, can_audit=True)
	public, private = create_dataset(db, create_user(db)), create_dataset(db, create_user(db), access='private')
	upsert_estimate(db, public)
	upsert_estimate(db, private)
	history_decision(db, public)
	act_as_anon(db)
	assert {r[0] for r in db.execute('SELECT dataset_id FROM public.v2_acquisition_date_estimates WHERE dataset_id IN (%s,%s)', (public, private))} == {public}
	assert db.execute('SELECT count(*) FROM public.acquisition_date_decisions WHERE dataset_id=%s', (public,)).fetchone() == (1,)
	# the decisions are read-only history
	act_as(db, auditor)
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute("INSERT INTO public.acquisition_date_decisions(dataset_id,source,date_valid) VALUES (%s,'auditor',true)", (public,))
