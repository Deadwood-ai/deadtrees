"""Georeferencing checks: access, the decision invariant and the re-review of disagreeing audits."""

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

QUEUE = 'SELECT item,fields,reason FROM public.audit_review_queue WHERE dataset_id=%s'


def check_json(dataset, decision, level, p90=None):
	return {
		'dataset_id': dataset,
		'model_version': 'romav2.0.1',
		'rules_version': 'georef-rules-v1',
		'decision': decision,
		'evidence_level': level,
		'reason': 'references_agree',
		'p90_m': p90,
		'reference_evidence': [],
	}


def write_check(db, dataset, decision, level, p90=None):
	"""Store a check and its suggestion the way the processor stage does."""
	act_as(db, processor_user(db), PROCESSOR_EMAIL)
	suggestion = (
		None if decision == 'uncertain' else {'value': decision == 'good', 'reason': level, 'details': {'p90_m': p90}}
	)
	db.execute(
		'SELECT public.store_georef_check(%s::jsonb, %s::jsonb)',
		(json.dumps(check_json(dataset, decision, level, p90)), json.dumps(suggestion)),
	)
	as_admin(db)


def audit_georeferencing(db, auditor, dataset, good):
	act_as(db, auditor)
	db.execute(
		"INSERT INTO public.dataset_audit(dataset_id,audited_by,is_georeferenced,audit_date) VALUES (%s,%s,%s,now() - interval '1 day')",
		(dataset, auditor, good),
	)
	as_admin(db)


def test_a_check_disagreeing_with_a_saved_audit_goes_to_re_review(db):
	auditor = create_user(db, can_audit=True)
	agrees, disagrees, uncertain = (create_dataset(db, create_user(db)) for _ in range(3))
	for dataset in (agrees, disagrees, uncertain):
		audit_georeferencing(db, auditor, dataset, True)

	write_check(db, agrees, 'good', 'strong', 2.7)
	write_check(db, disagrees, 'poor', 'strong', 22.6)
	write_check(db, uncertain, 'uncertain', 'insufficient')

	assert db.execute(QUEUE, (agrees,)).fetchall() == []
	assert db.execute(QUEUE, (disagrees,)).fetchall() == [
		('is_georeferenced', ['is_georeferenced'], 'suggestion_changed:georef_check_v1')
	]
	assert db.execute(QUEUE, (uncertain,)).fetchall() == []

	# the auditor confirms the saved verdict: saving takes it off the queue until the evidence changes again
	act_as(db, auditor)
	db.execute(
		"UPDATE public.dataset_audit SET is_georeferenced=true, audit_date=now() + interval '1 second' WHERE dataset_id=%s",
		(disagrees,),
	)
	as_admin(db)
	assert db.execute(QUEUE, (disagrees,)).fetchall() == []
	# an uncertain rerun removes the earlier suggestion instead of leaving it stale
	write_check(db, disagrees, 'uncertain', 'conflict')
	assert db.execute(
		'SELECT count(*) FROM public.dataset_audit_suggestions WHERE dataset_id=%s', (disagrees,)
	).fetchone() == (0,)


def test_read_access_follows_dataset_visibility_and_only_the_processor_writes(db):
	owner = create_user(db)
	public, private = create_dataset(db, owner), create_dataset(db, create_user(db), access='private')
	unchecked = create_dataset(db, owner)
	write_check(db, public, 'good', 'qualified', 4.0)
	write_check(db, private, 'poor', 'qualified', 30.0)

	act_as_anon(db)
	assert {
		r[0]
		for r in db.execute(
			'SELECT dataset_id FROM public.v2_georef_checks WHERE dataset_id IN (%s,%s)', (public, private)
		)
	} == {public}
	act_as(db, owner)
	assert (
		db.execute('UPDATE public.v2_georef_checks SET decision=%s WHERE dataset_id=%s', ('poor', public)).rowcount == 0
	)
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute(
			"INSERT INTO public.v2_georef_checks(dataset_id,model_version,rules_version,decision,evidence_level,reason) VALUES (%s,'x','x','good','strong','x')",
			(unchecked,),
		)


def test_uncertain_decisions_carry_an_uncertain_evidence_level(db):
	dataset = create_dataset(db, create_user(db))
	with pytest.raises(psycopg.errors.CheckViolation):
		write_check(db, dataset, 'uncertain', 'strong')


def test_a_failed_store_changes_neither_the_check_nor_the_suggestion(db):
	dataset = create_dataset(db, create_user(db))
	write_check(db, dataset, 'poor', 'strong', 22.6)
	act_as(db, processor_user(db), PROCESSOR_EMAIL)
	db.execute('SAVEPOINT broken')
	with pytest.raises(psycopg.errors.CheckViolation):
		# an invalid check aborts the whole call, so the suggestion cannot be dropped alone
		db.execute(
			'SELECT public.store_georef_check(%s::jsonb, NULL)',
			(json.dumps(check_json(dataset, 'uncertain', 'strong')),),
		)
	db.execute('ROLLBACK TO SAVEPOINT broken')
	as_admin(db)
	assert db.execute('SELECT decision FROM public.v2_georef_checks WHERE dataset_id=%s', (dataset,)).fetchone() == (
		'poor',
	)
	assert db.execute(
		"SELECT value FROM public.dataset_audit_suggestions WHERE dataset_id=%s AND field='is_georeferenced'",
		(dataset,),
	).fetchone() == (False,)


def test_only_the_processor_stores_checks(db):
	dataset = create_dataset(db, create_user(db))
	act_as(db, create_user(db, can_audit=True))
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute(
			'SELECT public.store_georef_check(%s::jsonb, NULL)',
			(json.dumps(check_json(dataset, 'good', 'strong', 2.0)),),
		)
