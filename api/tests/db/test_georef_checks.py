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


def reference(p90, inliers=500, inlier_fraction=0.9, cells=12, provider='esri'):
	"""A reference's evidence; the processor's flags and vote are left out: the audit does not read them."""
	return {'provider': provider, 'inliers': inliers, 'inlier_fraction': inlier_fraction, 'cells': cells, 'p90_m': p90}


def check_json(dataset, decision, level, p90=None, refs=None, reason=None):
	if refs is None:
		# an uncertain check: its one reference has plenty of matches, bunched in two grid cells
		refs = [reference(p90 or 14.0, cells=2 if decision == 'uncertain' else 12)]
	return {
		'dataset_id': dataset,
		'model_version': 'romav2.0.1',
		'rules_version': 'georef-rules-v1',
		'decision': decision,
		'evidence_level': level,
		'reason': reason or ('unstable_near_threshold' if decision == 'uncertain' else 'references_agree'),
		'p90_m': p90,
		'reference_evidence': refs,
	}


def write_check(db, dataset, decision, level, p90=None, refs=None, reason=None):
	"""Store a check the way the processor stage does."""
	act_as(db, processor_user(db), PROCESSOR_EMAIL)
	db.execute(
		'SELECT public.store_georef_check(%s::jsonb)', (json.dumps(check_json(dataset, decision, level, p90, refs, reason)),)
	)
	as_admin(db)


def georef_output(db, dataset):
	return db.execute(
		'SELECT georef_status, georef_offset_m, review_required FROM audit.dataset_outcomes WHERE dataset_id=%s', (dataset,)
	).fetchone()


def test_the_check_stores_only_its_row_and_the_audit_reads_it(db):
	dataset = create_dataset(db, create_user(db))
	write_check(db, dataset, 'uncertain', 'conflict')
	assert db.execute(RESULT, (dataset,)).fetchone() == ('needs_review', 'check', ['georef'])
	# a rerun replaces the row; the output is worked out again at once, no audit run is stored
	write_check(db, dataset, 'good', 'strong', 2.7)
	assert db.execute(RESULT, (dataset,)).fetchone() == ('estimated', 'check', [])
	assert db.execute('SELECT count(*) FROM audit.runs WHERE dataset_id=%s', (dataset,)).fetchone() == (0,)
	assert db.execute("SELECT count(*) FROM audit.check_versions WHERE check_key='georef'").fetchone() == (0,)


def test_the_check_estimates_an_offset_and_judges_none(db):
	dataset = create_dataset(db, create_user(db))
	# far over 15 m is an estimate too, not a verdict
	write_check(db, dataset, 'poor', 'strong', 22.6, refs=[reference(22.6)])
	assert georef_output(db, dataset) == ('estimated', 22.6, [])
	# 15426: the processor called it uncertain (one reference flips across 15 m under its
	# holdouts); the offset is the median of the references that matched well
	refs = [
		reference(31.0, provider='esri_clarity'),
		reference(5.0, provider='esri'),
		reference(3.0, provider='bing'),
		reference(8.0, provider='dop'),
		reference(80.0, inliers=40, provider='yandex'),  # too few matches: does not count
	]
	write_check(db, dataset, 'uncertain', 'conflict', 6.5, refs=refs)
	assert georef_output(db, dataset) == ('estimated', 6.5, [])


def test_plenty_of_poor_matches_need_a_person(db):
	dataset = create_dataset(db, create_user(db))
	# plenty of matches, but inconsistent or bunched in one corner: no estimate
	refs = [reference(9.0, inlier_fraction=0.3), reference(30.0, cells=2, provider='bing')]
	write_check(db, dataset, 'uncertain', 'insufficient', refs=refs, reason='no_qualified_reference')
	assert georef_output(db, dataset) == ('needs_review', None, ['georef'])


def test_no_reference_imagery_is_said_and_needs_no_review(db):
	dataset = create_dataset(db, create_user(db))
	write_check(db, dataset, 'uncertain', 'insufficient', refs=[], reason='no_qualified_reference')
	assert georef_output(db, dataset) == ('no_reference', None, [])
	# a reference with few matches is no reference either
	write_check(db, dataset, 'uncertain', 'insufficient', refs=[reference(None, inliers=12, inlier_fraction=0.2, cells=1)])
	assert georef_output(db, dataset) == ('no_reference', None, [])


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
