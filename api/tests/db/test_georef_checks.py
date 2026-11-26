"""Georeferencing checks: access, the decision invariant, and the check output in the audit."""

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

RESULT = 'SELECT georef_status, georef_source, review_required FROM audit.dataset_outcomes WHERE dataset_id=%s'


def check_json(dataset, decision, level, p90=None):
	return {
		'dataset_id': dataset,
		'model_version': 'romav2.0.1',
		'rules_version': 'georef-rules-v1',
		'decision': decision,
		'evidence_level': level,
		'reason': 'references_disagree' if decision == 'uncertain' else 'references_agree',
		'p90_m': p90,
		'reference_evidence': [{'provider': 'esri', 'qualified': True, 'decides': True, 'support': 0.6, 'p90_m': p90 or 14.0}],
	}


def write_check(db, dataset, decision, level, p90=None):
	"""Store a check the way the processor stage does."""
	act_as(db, processor_user(db), PROCESSOR_EMAIL)
	db.execute('SELECT public.store_georef_check(%s::jsonb)', (json.dumps(check_json(dataset, decision, level, p90)),))
	as_admin(db)


def test_the_check_stores_only_its_row_and_the_audit_reads_it(db):
	dataset = create_dataset(db, create_user(db))
	write_check(db, dataset, 'uncertain', 'conflict')
	assert db.execute(RESULT, (dataset,)).fetchone() == ('needs_review', 'check', ['georef'])
	# a rerun replaces the row; the output is worked out again at once, no audit run is stored
	write_check(db, dataset, 'good', 'strong', 2.7)
	assert db.execute(RESULT, (dataset,)).fetchone() == ('estimated', 'check', [])
	assert db.execute('SELECT count(*) FROM audit.runs WHERE dataset_id=%s', (dataset,)).fetchone() == (0,)
	assert db.execute("SELECT count(*) FROM audit.check_versions WHERE check_key='georef'").fetchone() == (0,)


def test_older_processors_sending_a_suggestion_fail_loudly(db):
	dataset = create_dataset(db, create_user(db))
	act_as(db, processor_user(db), PROCESSOR_EMAIL)
	with pytest.raises(psycopg.errors.UndefinedFunction):
		db.execute(
			'SELECT public.store_georef_check(%s::jsonb, NULL::jsonb, %s)',
			(json.dumps(check_json(dataset, 'good', 'strong', 2.0)), 'upload'),
		)


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


def test_a_failed_store_changes_nothing(db):
	dataset = create_dataset(db, create_user(db))
	write_check(db, dataset, 'poor', 'strong', 22.6)
	act_as(db, processor_user(db), PROCESSOR_EMAIL)
	db.execute('SAVEPOINT broken')
	with pytest.raises(psycopg.errors.CheckViolation):
		# an invalid check aborts the whole call, so the run is not stored alone
		db.execute(
			'SELECT public.store_georef_check(%s::jsonb)',
			(json.dumps(check_json(dataset, 'uncertain', 'strong')),),
		)
	db.execute('ROLLBACK TO SAVEPOINT broken')
	as_admin(db)
	assert db.execute('SELECT decision FROM public.v2_georef_checks WHERE dataset_id=%s', (dataset,)).fetchone() == (
		'poor',
	)


def test_only_the_processor_stores_checks(db):
	dataset = create_dataset(db, create_user(db))
	act_as(db, create_user(db, can_audit=True))
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute(
			'SELECT public.store_georef_check(%s::jsonb)',
			(json.dumps(check_json(dataset, 'good', 'strong', 2.0)),),
		)
