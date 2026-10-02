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


def write_check(db, dataset, decision, level, p90=None):
	"""Store a check and its suggestion the way the processor stage does."""
	act_as(db, processor_user(db), PROCESSOR_EMAIL)
	db.execute(
		'INSERT INTO public.v2_georef_checks(dataset_id,model_version,rules_version,decision,evidence_level,reason,p90_m,reference_evidence) '
		"VALUES (%s,'romav2.0.1','georef-rules-v1',%s,%s,'references_agree',%s,'[]') "
		'ON CONFLICT (dataset_id) DO UPDATE SET decision=excluded.decision,evidence_level=excluded.evidence_level,p90_m=excluded.p90_m',
		(dataset, decision, level, p90),
	)
	if decision == 'uncertain':
		db.execute(
			"DELETE FROM public.dataset_audit_suggestions WHERE dataset_id=%s AND source='georef_check_v1'", (dataset,)
		)
	else:
		db.execute(
			"INSERT INTO public.dataset_audit_suggestions(dataset_id,field,value,source,reason,details) VALUES (%s,'is_georeferenced',%s,'georef_check_v1',%s,%s) "
			'ON CONFLICT (dataset_id,field) DO UPDATE SET value=excluded.value,reason=excluded.reason,details=excluded.details',
			(dataset, json.dumps(decision == 'good'), level, json.dumps({'p90_m': p90})),
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
