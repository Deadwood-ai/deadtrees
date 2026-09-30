"""Acquisition-date estimates, audit suggestions and the date-decision lifecycle."""
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


def audit(db, auditor, dataset, valid, accept=None):
	act_as(db, auditor)
	db.execute(
		'INSERT INTO public.dataset_audit(dataset_id,audited_by,has_valid_acquisition_date,accept_suggested_acquisition_date) VALUES (%s,%s,%s,%s) '
		'ON CONFLICT (dataset_id) DO UPDATE SET has_valid_acquisition_date=excluded.has_valid_acquisition_date,'
		'accept_suggested_acquisition_date=excluded.accept_suggested_acquisition_date',
		(dataset, auditor, valid, accept),
	)
	as_admin(db)


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


def test_accepting_applies_a_marked_date_and_a_new_decision_deactivates_the_old(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	upsert_estimate(db, dataset)

	audit(db, auditor, dataset, False, True)
	y, m, d, source, decision_id = dataset_row(db, dataset)
	assert (y, m, d, source) == (2022, 7, 19, 'model_suggestion')
	(first_id, src, valid, suggestion, reason), = decisions(db, dataset)
	assert (src, valid, suggestion, reason) == ('auditor', False, 'accepted', None) and decision_id == first_id
	reported, evidence = db.execute(
		'SELECT array[reported_year,reported_month,reported_day],evidence FROM public.acquisition_date_decisions WHERE id=%s', (first_id,)
	).fetchone()
	assert reported == [2022, 3, 11] and evidence['recorded_offset_days'] == 130 and len(evidence['probabilities']) == 365
	history = {r[0] for r in db.execute('SELECT field_name FROM public.v2_dataset_edit_history WHERE dataset_id=%s', (dataset,))}
	assert history == {'aquisition_month', 'aquisition_day'}

	audit(db, auditor, dataset, False, True)  # re-saving the same outcome
	assert len(decisions(db, dataset)) == 1

	audit(db, auditor, dataset, False, False)  # changed mind: keep the reported date
	rows = decisions(db, dataset)
	assert [r[4] for r in rows] == ['new_decision', None] and rows[1][3] == 'rejected'
	assert dataset_row(db, dataset)[:4] == (2022, 3, 11, 'reported')


def test_accepting_needs_a_suggestion_for_the_current_date(db):
	auditor = create_user(db, can_audit=True)
	no_suggestion = create_dataset(db, create_user(db))
	upsert_estimate(db, no_suggestion, mismatch=False, suggested=None)
	act_as(db, auditor)
	with pytest.raises(psycopg.errors.CheckViolation):
		db.execute('INSERT INTO public.dataset_audit(dataset_id,audited_by,has_valid_acquisition_date,accept_suggested_acquisition_date) VALUES (%s,%s,true,true)', (no_suggestion, auditor))
	db.rollback()

	auditor = create_user(db, can_audit=True)
	changed = create_dataset(db, create_user(db), date=(2022, 5, 1))
	upsert_estimate(db, changed, recorded=(2022, 3, 11))
	act_as(db, auditor)
	with pytest.raises(psycopg.errors.SerializationFailure):
		db.execute('INSERT INTO public.dataset_audit(dataset_id,audited_by,has_valid_acquisition_date,accept_suggested_acquisition_date) VALUES (%s,%s,false,true)', (changed, auditor))


def test_a_contradicting_estimate_reopens_the_date_check(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	upsert_estimate(db, dataset, mismatch=False, suggested=None)
	audit(db, auditor, dataset, True)
	assert decisions(db, dataset)[0][4] is None

	upsert_estimate(db, dataset, mismatch=False, suggested=None, version='doy_estimation_v2')  # agrees: stays
	assert decisions(db, dataset)[0][4] is None
	upsert_estimate(db, dataset, mismatch=True, version='doy_estimation_v2')  # disagrees: reopened
	assert decisions(db, dataset)[0][4] == 'estimate_contradicts'
	# the saved audit keeps its verdict (exports read it); only the decision is reopened
	assert db.execute(
		'SELECT has_valid_acquisition_date FROM public.dataset_audit WHERE dataset_id=%s', (dataset,)
	).fetchone() == (True,)
	assert db.execute("SELECT reason FROM public.audit_review_queue WHERE dataset_id=%s AND item='acquisition_date'", (dataset,)).fetchone() == (
		'estimate_contradicts',
	)
	# confirming the same verdict on the reopened check records a new decision
	audit(db, auditor, dataset, True)
	assert [r[4] for r in decisions(db, dataset)] == ['estimate_contradicts', None]

	# found invalid (and kept, no suggestion), but the model sees no problem
	doubted = create_dataset(db, create_user(db))
	audit(db, auditor, doubted, False)
	upsert_estimate(db, doubted, mismatch=False, suggested=None)
	assert decisions(db, doubted)[0][4] == 'estimate_contradicts'


def test_hand_edit_and_cutoff_deactivate_decisions(db):
	auditor = create_user(db, can_audit=True)
	edited = create_dataset(db, create_user(db))
	upsert_estimate(db, edited)
	audit(db, auditor, edited, False, True)
	as_admin(db)
	db.execute('UPDATE public.v2_datasets SET aquisition_day=20 WHERE id=%s', (edited,))
	assert dataset_row(db, edited)[3:] == ('reported', None)
	assert decisions(db, edited)[0][4] == 'date_edited'

	older = create_dataset(db, create_user(db))
	upsert_estimate(db, older, mismatch=False, suggested=None)
	audit(db, auditor, older, True)
	assert db.execute("SELECT public.supersede_acquisition_date_decisions_before(now() + interval '1 minute')").fetchone()[0] >= 1
	assert decisions(db, older)[0][4] == 'cutoff'


def test_automatic_decisions_never_override_a_person(db):
	auditor = create_user(db, can_audit=True)
	processor = processor_user(db)
	auto = create_dataset(db, create_user(db))
	upsert_estimate(db, auto)
	act_as(db, processor, email=PROCESSOR_EMAIL)
	db.execute('SELECT public.record_automatic_acquisition_date_decision(%s)', (auto,))
	assert [r[1:4] for r in decisions(db, auto)] == [('automatic', False, 'accepted')]
	assert dataset_row(db, auto)[3] == 'model_suggestion'

	human = create_dataset(db, create_user(db))
	upsert_estimate(db, human)
	audit(db, auditor, human, True, False)
	act_as(db, processor, email=PROCESSOR_EMAIL)
	db.execute('SELECT public.record_automatic_acquisition_date_decision(%s)', (human,))
	assert [r[1] for r in decisions(db, human)] == ['auditor']

	act_as(db, auditor)
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute('SELECT public.record_automatic_acquisition_date_decision(%s)', (human,))


def test_read_access_follows_roles_and_visibility(db):
	auditor, viewer = create_user(db, can_audit=True), create_user(db)
	public, private = create_dataset(db, create_user(db)), create_dataset(db, create_user(db), access='private')
	upsert_estimate(db, public)
	upsert_estimate(db, private)
	audit(db, auditor, public, False, True)
	db.execute(
		"INSERT INTO public.dataset_audit_suggestions(dataset_id,field,value,source) VALUES (%s,'has_valid_acquisition_date','false','doy_estimation_v1')",
		(public,),
	)
	act_as_anon(db)
	assert {r[0] for r in db.execute('SELECT dataset_id FROM public.v2_acquisition_date_estimates WHERE dataset_id IN (%s,%s)', (public, private))} == {public}
	assert db.execute('SELECT count(*) FROM public.acquisition_date_decisions WHERE dataset_id=%s', (public,)).fetchone() == (1,)
	act_as(db, auditor)
	assert db.execute('SELECT count(*) FROM public.dataset_audit_suggestions WHERE dataset_id=%s', (public,)).fetchone() == (1,)
	assert db.execute('SELECT accept_suggested_acquisition_date FROM public.get_dataset_audit_with_emails(%s)', (public,)).fetchone() == (True,)
	act_as(db, viewer)
	assert db.execute('SELECT count(*) FROM public.dataset_audit_suggestions WHERE dataset_id=%s', (public,)).fetchone() == (0,)
	# decisions are written only through the recording functions
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute("INSERT INTO public.acquisition_date_decisions(dataset_id,source,date_valid) VALUES (%s,'auditor',true)", (public,))


def test_review_queue_lists_any_audit_item_newer_evidence_disagrees_with(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	act_as(db, auditor)
	db.execute(
		"INSERT INTO public.dataset_audit(dataset_id,audited_by,has_valid_phenology,audit_date) VALUES (%s,%s,true,now() - interval '1 day')",
		(dataset, auditor),
	)
	as_admin(db)
	queue = "SELECT item,fields,reason FROM public.audit_review_queue WHERE dataset_id=%s"

	# a suggestion that agrees with the saved value, or is older than the audit, is not listed
	db.execute(
		"INSERT INTO public.dataset_audit_suggestions(dataset_id,field,value,source,changed_at) VALUES (%s,'has_valid_phenology','false','phenology_v1',now() - interval '2 days')",
		(dataset,),
	)
	assert db.execute(queue, (dataset,)).fetchall() == []
	# a rerun repeating the same value does not make it new
	db.execute("UPDATE public.dataset_audit_suggestions SET value='false', updated_at=now() WHERE dataset_id=%s", (dataset,))
	assert db.execute(queue, (dataset,)).fetchall() == []
	# the value flips and flips back after the audit: newer evidence disagrees
	db.execute("UPDATE public.dataset_audit_suggestions SET value='true' WHERE dataset_id=%s", (dataset,))
	db.execute("UPDATE public.dataset_audit_suggestions SET value='false' WHERE dataset_id=%s", (dataset,))
	assert db.execute(queue, (dataset,)).fetchall() == [('has_valid_phenology', ['has_valid_phenology'], 'suggestion_changed:phenology_v1')]

	# saving the audit again takes it off
	audit_row = "UPDATE public.dataset_audit SET has_valid_phenology=true, audit_date=now() + interval '1 second' WHERE dataset_id=%s"
	act_as(db, auditor)
	db.execute(audit_row, (dataset,))
	as_admin(db)
	assert db.execute(queue, (dataset,)).fetchall() == []
