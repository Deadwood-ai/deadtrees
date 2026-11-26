"""Audit Review: check outputs per dataset (audit.dataset_results), the evaluation decision and the exclusion."""

import json
from pathlib import Path

import psycopg
import pytest

from api.tests.db.test_acquisition_date_estimates import (  # noqa: F401
	act_as,
	act_as_anon,
	as_admin,
	create_dataset,
	create_user,
	db,
	upsert_estimate,
)
from api.tests.db.test_audit_checks import (
	as_worker,
	create_crop,
	create_operator,
	create_run,
	register_version,
)

MIGRATIONS = Path(__file__).resolve().parents[3] / 'supabase/migrations'
CUTS = {'decider': 'haiku'}


def result(db, dataset, *columns):
	as_admin(db)
	return db.execute(f'SELECT {", ".join(columns)} FROM audit.dataset_results WHERE dataset_id=%s', (dataset,)).fetchone()


def finished(db, dataset):
	db.execute(
		'INSERT INTO public.v2_statuses(dataset_id,current_status,is_cog_done,is_combined_model_done) '
		"VALUES (%s,'idle',true,true)",
		(dataset,),
	)


def evaluation_run(db, dataset, verdict, output=None, version='rule-v3-test'):
	run = create_run(db, dataset, register_version(db, 'dataset_evaluation', version), check='dataset_evaluation')
	as_worker(db)
	db.execute(
		'INSERT INTO audit.assessments(check_key,dataset_id,run_id,layer,assessor_kind,model,prompt_version,verdict,output) '
		"VALUES ('dataset_evaluation',%s,%s,'image','rule','dataset-evaluation-rule','v3',%s,%s)",
		(dataset, run, verdict, json.dumps(output) if output else None),
	)
	as_admin(db)
	return run


def answer(db, auditor, dataset, check, layer, run=None, verdict=None, output=None, crop=None, note=None):
	act_as(db, auditor)
	db.execute(
		'INSERT INTO audit.assessments(check_key,dataset_id,crop_id,run_id,layer,assessor_kind,assessor_user_id,verdict,output,reason_text) '
		"VALUES (%s,%s,%s,%s,%s,'person',%s,%s,%s,%s)",
		(check, dataset, crop, run, layer, auditor, verdict, json.dumps(output) if output else None, note),
	)
	as_admin(db)


def legacy(db, dataset, verdict):
	as_admin(db)
	db.execute(
		'INSERT INTO audit.assessments(check_key,dataset_id,layer,assessor_kind,verdict,imported_from,created_at) '
		"VALUES ('dataset_evaluation',%s,'image','person',%s,'legacy_audit',now() - interval '1 year')",
		(dataset, verdict),
	)


def judge(db, dataset, run, crop, model, layer, verdict, likelihood=None):
	as_worker(db)
	db.execute(
		'INSERT INTO audit.assessments(check_key,dataset_id,crop_id,run_id,layer,assessor_kind,model,prompt_version,verdict,major_likelihood) '
		"VALUES ('prediction_quality',%s,%s,%s,%s,'model',%s,'v4',%s,%s)",
		(dataset, crop, run, layer, model, verdict, likelihood),
	)
	as_admin(db)


# ---------------------------------------------------------------------------
# Rows and constraints
# ---------------------------------------------------------------------------


def test_verdict_is_required_only_for_the_evaluation_and_crops(db):
	auditor, dataset = create_user(db, can_audit=True), create_dataset(db, create_user(db))
	answer(db, auditor, dataset, 'georef', 'georef', output={'status': 'passed'})
	# ambiguous is only an answer on a crop's prediction layer, a person's or a model's
	crop = create_crop(db, dataset, x0=512)
	answer(db, auditor, dataset, 'prediction_quality', 'forest_cover', verdict='ambiguous', crop=crop)
	run = create_run(db, dataset, register_version(db, 'prediction_quality', 'pq-ambiguous-test'))
	judge(db, dataset, run, crop, 'haiku-5.5', 'deadwood', 'ambiguous', 50)
	for check, layer, row_crop in (('dataset_evaluation', 'image', None), ('prediction_quality', 'image', crop)):
		db.execute('SAVEPOINT s')
		with pytest.raises(psycopg.errors.CheckViolation):
			answer(db, auditor, dataset, check, layer, verdict='ambiguous', crop=row_crop)
		db.execute('ROLLBACK TO SAVEPOINT s')
	for check, layer, crop in (('dataset_evaluation', 'image', None), ('prediction_quality', 'deadwood', create_crop(db, dataset))):
		db.execute('SAVEPOINT s')
		with pytest.raises(psycopg.errors.CheckViolation):
			answer(db, auditor, dataset, check, layer, crop=crop)
		db.execute('ROLLBACK TO SAVEPOINT s')
	db.execute('SAVEPOINT s')
	with pytest.raises(psycopg.errors.CheckViolation):
		answer(db, auditor, dataset, 'georef', 'georef', output=['passed'])
	db.execute('ROLLBACK TO SAVEPOINT s')


def test_a_date_override_needs_a_note_and_only_imports_lack_an_auditor(db):
	auditor, dataset = create_user(db, can_audit=True), create_dataset(db, create_user(db))
	for note in (None, '  '):
		db.execute('SAVEPOINT s')
		with pytest.raises(psycopg.errors.CheckViolation):
			answer(db, auditor, dataset, 'acquisition_date', 'acquisition_date', output={'replace': True}, note=note)
		db.execute('ROLLBACK TO SAVEPOINT s')
	answer(db, auditor, dataset, 'acquisition_date', 'acquisition_date', output={'replace': True}, note='leaf-off, so spring')

	legacy(db, dataset, 'ok')
	db.execute('SAVEPOINT s')
	with pytest.raises(psycopg.errors.CheckViolation):
		db.execute(
			'INSERT INTO audit.assessments(check_key,dataset_id,layer,assessor_kind,verdict) '
			"VALUES ('dataset_evaluation',%s,'image','person','ok')",
			(dataset,),
		)
	db.execute('ROLLBACK TO SAVEPOINT s')
	# an auditor never writes an imported row
	act_as(db, auditor)
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute(
			'INSERT INTO audit.assessments(check_key,dataset_id,layer,assessor_kind,assessor_user_id,verdict,imported_from) '
			"VALUES ('dataset_evaluation',%s,'image','person',%s,'major','legacy_audit')",
			(dataset, auditor),
		)


def test_the_duplicate_check_and_the_old_queues_are_gone(db):
	assert db.execute(
		"SELECT to_regclass('audit.image_hashes'), to_regclass('audit.review_queue'), to_regclass('audit.disagreements'),"
		" to_regclass('public.audit_review_queue'),"
		" to_regprocedure('audit.duplicate_candidates(bigint,bigint,text,integer,real)')"
	).fetchone() == (None,) * 5


# ---------------------------------------------------------------------------
# The evaluation decision and the exclusion
# ---------------------------------------------------------------------------


def test_a_reviewer_beats_a_legacy_ok_which_beats_the_check_which_beats_a_legacy_exclusion(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	finished(db, dataset)
	columns = ('evaluation_decision', 'evaluation_source', 'cog_issue', 'thumbnail_issue')
	# a legacy exclusion holds while the evaluation has not decided
	legacy(db, dataset, 'major')
	assert result(db, dataset, 'evaluation_decision', 'evaluation_source') == ('exclude', 'legacy')
	unsure = evaluation_run(db, dataset, 'unsure', version='rule-unsure-test')
	assert result(db, dataset, 'evaluation_decision', 'evaluation_source', 'review_required') == (
		'exclude',
		'legacy',
		['evaluation', 'aoi'],
	)
	# and yields once it decides
	run = evaluation_run(db, dataset, 'ok', {'cog_issue': True, 'thumbnail_issue': False})
	assert result(db, dataset, *columns) == ('ok', 'check', True, False)
	assert unsure != run

	# a legacy ok beats the check
	evaluation_run(db, dataset, 'major', version='rule-major-test')
	assert result(db, dataset, 'evaluation_decision', 'evaluation_source') == ('exclude', 'check')
	legacy(db, dataset, 'ok')
	assert result(db, dataset, 'evaluation_decision', 'evaluation_source') == ('ok', 'legacy')

	answer(db, auditor, dataset, 'dataset_evaluation', 'image', run, 'major', {'cog_issue': False, 'thumbnail_issue': True})
	assert result(db, dataset, *columns) == ('exclude', 'reviewer', False, True)
	# the latest reviewer answer counts; an earlier "keep, fix" is ok, against the current run's exclusion
	answer(db, create_user(db, can_audit=True), dataset, 'dataset_evaluation', 'image', run, 'minor')
	assert result(db, dataset, *columns) == ('ok', 'reviewer', None, None)


def test_an_unsure_check_needs_review_until_a_reviewer_answers_on_its_evidence(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	finished(db, dataset)
	db.execute(
		"INSERT INTO public.v2_aois(dataset_id,user_id,geometry,source) VALUES (%s,%s,'{}','manual')", (dataset, auditor)
	)
	old = evaluation_run(db, dataset, 'unsure', version='rule-old-test')
	run = evaluation_run(db, dataset, 'unsure')
	assert result(db, dataset, 'evaluation_decision', 'evaluation_source', 'review_required') == (None, None, ['evaluation'])
	# an answer on an older run judged other evidence
	answer(db, auditor, dataset, 'dataset_evaluation', 'image', old, 'major')
	assert result(db, dataset, 'evaluation_decision', 'review_required') == ('exclude', ['evaluation'])
	answer(db, auditor, dataset, 'dataset_evaluation', 'image', run, 'major')
	assert result(db, dataset, 'evaluation_decision', 'review_required') == ('exclude', [])


def test_a_review_holds_for_the_same_evidence_and_reopens_for_a_new_ortho(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))

	def run_on(inputs, version, source=None):
		version_id = register_version(db, 'dataset_evaluation', version)
		run = create_run(db, dataset, version_id, check='dataset_evaluation', source=source)
		as_admin(db)
		db.execute('UPDATE audit.runs SET inputs=%s WHERE id=%s', (json.dumps(inputs), run))
		as_worker(db)
		db.execute(
			'INSERT INTO audit.assessments(check_key,dataset_id,run_id,layer,assessor_kind,model,prompt_version,verdict) '
			"VALUES ('dataset_evaluation',%s,%s,'image','rule','dataset-evaluation-rule','v3','unsure')",
			(dataset, run),
		)
		as_admin(db)
		return run

	ortho_a = {'ortho_sha256': 'a' * 64}
	first = run_on(ortho_a, 'ev-1')
	answer(db, auditor, dataset, 'dataset_evaluation', 'image', first, 'ok')
	assert result(db, dataset, 'review_required') == ([],)
	# a rule-only recomputation and a new prompt on the same inputs keep the review
	run_on({}, 'ev-2', source=first)
	assert result(db, dataset, 'review_required') == ([],)
	run_on(ortho_a, 'ev-3')
	assert result(db, dataset, 'review_required') == ([],)
	# a replaced ortho reopens it; the reviewer's decision still stands until someone answers again
	run_on({'ortho_sha256': 'b' * 64}, 'ev-4')
	assert result(db, dataset, 'review_required', 'evaluation_decision') == (['evaluation'], 'ok')


def test_exclusion_hides_a_dataset_from_the_public_surface_only_by_its_decision(db):
	owner, auditor = create_user(db), create_user(db, can_audit=True)
	excluded, kept = create_dataset(db, owner), create_dataset(db, owner)
	legacy(db, excluded, 'major')
	run = evaluation_run(db, kept, 'major')
	answer(db, auditor, kept, 'dataset_evaluation', 'image', run, 'ok')

	as_admin(db)
	ids = (excluded, kept)
	assert db.execute(
		'SELECT array_agg(i ORDER BY i) FROM audit.excluded_dataset_ids() i WHERE i IN (%s,%s)', ids
	).fetchone() == ([excluded],)
	assert db.execute('SELECT audit.is_dataset_excluded(%s), audit.is_dataset_excluded(%s)', ids).fetchone() == (
		True,
		False,
	)
	act_as_anon(db)
	public = 'SELECT array_agg(id ORDER BY id) FROM public.v2_full_dataset_view_public WHERE id IN (%s,%s)'
	assert db.execute(public, ids).fetchone() == ([kept],)
	assert db.execute(
		'SELECT internal.is_dataset_excluded_from_public_surface(%s), internal.is_dataset_excluded_from_public_surface(%s)',
		ids,
	).fetchone() == (True, False)
	assert db.execute('SELECT audit_decision, is_audited FROM public.v2_full_dataset_view WHERE id=%s', (kept,)).fetchone() == (
		None,
		False,
	)
	# the owner sees the decision on their own dataset; auditors see every decision
	act_as(db, owner)
	assert db.execute(
		'SELECT array_agg(audit_decision ORDER BY id) FROM public.v2_full_dataset_view_owner WHERE id IN (%s,%s)', ids
	).fetchone() == (['exclude', 'ok'],)
	assert db.execute('SELECT public.get_dataset_status_details(%s)', (excluded,)).fetchone()[0]['audit_decision'] == 'exclude'
	act_as(db, auditor)
	assert db.execute('SELECT audit_decision, is_audited FROM public.v2_full_dataset_view WHERE id=%s', (kept,)).fetchone() == (
		'ok',
		True,
	)
	# the evaluation lifts the legacy exclusion once it decides
	evaluation_run(db, excluded, 'ok', version='rule-lift-test')
	act_as_anon(db)
	assert db.execute(public, ids).fetchone() == ([excluded, kept],)


def test_predictions_are_never_hidden_by_the_audit(db):
	columns = {
		r[0]
		for r in db.execute(
			"SELECT column_name FROM information_schema.columns WHERE table_schema='public'"
			" AND table_name IN ('v2_full_dataset_view','v2_full_dataset_view_public','v2_full_dataset_view_owner')"
		)
	}
	assert 'audit_decision' in columns and 'phenology_probability' in columns
	assert not columns & {'show_deadwood_predictions', 'show_forest_cover_predictions', 'final_assessment', 'deadwood_quality'}


def test_the_legacy_import_keeps_only_decisions(db):
	sql = (MIGRATIONS / '20261117140000_audit_review_outputs.sql').read_text()
	start = sql.index('insert into audit.assessments (check_key, dataset_id, layer')
	insert = sql[start : sql.index(';', start)]
	auditor = create_user(db, can_audit=True)
	rows = {}
	for assessment, auditor_id in (
		('exclude_completely', None),
		('no_issues', auditor),
		('ready', None),
		('fixable_issues', auditor),
		(None, auditor),
	):
		dataset = create_dataset(db, create_user(db))
		db.execute(
			"INSERT INTO public.dataset_audit_legacy(dataset_id,audit_date,final_assessment,audited_by) VALUES (%s,'2025-05-01',%s,%s)",
			(dataset, assessment, auditor_id),
		)
		rows[dataset] = assessment
	db.execute(insert)
	db.execute(insert)  # a second run adds nothing
	imported = db.execute(
		"SELECT dataset_id, verdict::text, assessor_user_id, created_at::date::text FROM audit.assessments"
		" WHERE imported_from='legacy_audit' AND dataset_id = ANY(%s) ORDER BY dataset_id",
		(list(rows),),
	).fetchall()
	assert [(rows[d], v, u, c) for d, v, u, c in imported] == [
		('exclude_completely', 'major', None, '2025-05-01'),
		('no_issues', 'ok', auditor, '2025-05-01'),
		('ready', 'ok', None, '2025-05-01'),
	]


# ---------------------------------------------------------------------------
# Check outputs
# ---------------------------------------------------------------------------


def georef_check(db, dataset, decision, level, reason, p90, references):
	as_admin(db)
	db.execute(
		'INSERT INTO public.v2_georef_checks(dataset_id,model_version,rules_version,decision,evidence_level,reason,p90_m,reference_evidence) '
		"VALUES (%s,'romav2.0.1','georef-rules-v1',%s,%s,%s,%s,%s)",
		(dataset, decision, level, reason, p90, json.dumps(references)),
	)
	return db.execute(
		'SELECT audit.georef_output_v1(c) FROM public.v2_georef_checks c WHERE dataset_id=%s', (dataset,)
	).fetchone()[0]


def test_georef_output(db):
	owner = create_user(db)
	qualified = [{'qualified': True, 'support': 0.2, 'p90_m': 1.47}, {'qualified': True, 'support': 0.1, 'p90_m': 9.0}]
	cases = [
		(('good', 'strong', 'references_agree', 3.2, qualified), {'status': 'estimated', 'offset_m': 3.2}),
		(('poor', 'qualified', 'references_agree', 22.6, qualified), {'status': 'estimated', 'offset_m': 22.6}),
		(('poor', 'gross', 'on_null_line', None, []), {'status': 'not_passed', 'offset_m': None}),
		(('uncertain', 'insufficient', 'no_qualified_reference', None, [{'qualified': False}]), {'status': 'no_reference', 'offset_m': None}),
		(('uncertain', 'insufficient', 'no_qualified_reference', None, qualified), {'status': 'needs_review', 'offset_m': 1.47}),
		(('uncertain', 'conflict', 'references_disagree', 14.0, qualified), {'status': 'needs_review', 'offset_m': 1.47}),
	]
	for args, expected in cases:
		assert georef_check(db, create_dataset(db, owner), *args) == expected


def test_a_reviewer_settles_a_georef_check_that_needs_review(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	georef_check(db, dataset, 'uncertain', 'conflict', 'unstable_near_threshold', 15.1, [{'qualified': True, 'support': 0.5, 'p90_m': 15.1}])
	run = create_run(db, dataset, register_version(db, 'georef', 'georef-test'), check='georef')
	columns = ('georef_status', 'georef_offset_m', 'georef_source', 'review_required')
	assert result(db, dataset, *columns) == ('needs_review', pytest.approx(15.1), 'check', ['georef'])
	answer(db, auditor, dataset, 'georef', 'georef', run, output={'status': 'passed'})
	assert result(db, dataset, *columns) == ('passed', pytest.approx(15.1), 'reviewer', [])


def estimate(db, dataset, precision, recorded, predicted, mismatch=False, hdi=60, modes=1):
	upsert_estimate(db, dataset, recorded=recorded, mismatch=mismatch, suggested=None)
	db.execute(
		'UPDATE public.v2_acquisition_date_estimates SET recorded_precision=%s,predicted_date=%s,hdi80_days=%s,n_modes=%s WHERE dataset_id=%s',
		(precision, predicted, hdi, modes, dataset),
	)
	return db.execute(
		"SELECT (o->>'replace')::boolean, o->>'reason', o->>'new_date' FROM public.v2_acquisition_date_estimates e,"
		' audit.acquisition_date_output_v1(e) o WHERE dataset_id=%s',
		(dataset,),
	).fetchone()


def test_acquisition_date_output(db):
	owner = create_user(db)
	cases = [
		(('day', (2022, 3, 11), '2022-07-19', True), (True, 'mismatch', '2022-07-19')),
		(('day', (2022, 3, 11), '2022-07-19', True, 120), (False, 'mismatch', None)),  # 80% range too wide
		(('day', (2022, 3, 11), '2022-07-19', True, 60, 2), (False, 'mismatch', None)),  # two modes
		(('year', (2022, None, None), '2022-07-19'), (True, 'missing_month', '2022-07-19')),
		(('month', (2022, 7, None), '2022-07-19'), (True, 'missing_day', '2022-07-19')),
		(('month', (2022, 6, None), '2022-07-19'), (False, None, None)),
		(('day', (2022, 7, 10), '2022-07-19'), (False, None, None)),
	]
	for args, expected in cases:
		assert estimate(db, create_dataset(db, owner), *args) == expected


def test_a_reviewer_overrides_the_date_replacement_and_nothing_changes_the_dataset(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	estimate(db, dataset, 'day', (2022, 3, 11), '2022-07-19', mismatch=True)
	columns = ('date_replace', 'date_new::text', 'date_predicted::text', 'date_source', 'review_required')
	assert result(db, dataset, *columns) == (True, '2022-07-19', '2022-07-19', 'check', [])
	answer(db, auditor, dataset, 'acquisition_date', 'acquisition_date', output={'replace': False}, note='the recorded date is right')
	assert result(db, dataset, *columns) == (False, None, '2022-07-19', 'reviewer', [])
	assert db.execute(
		'SELECT aquisition_month, aquisition_date_source FROM public.v2_datasets WHERE id=%s', (dataset,)
	).fetchone() == (3, 'reported')
	assert db.execute('SELECT count(*) FROM public.acquisition_date_decisions WHERE dataset_id=%s', (dataset,)).fetchone() == (0,)

	# AerialStamp dates it again: the override no longer counts and the date needs a reviewer
	db.execute(
		"UPDATE public.v2_acquisition_date_estimates SET updated_at = now() + interval '1 hour' WHERE dataset_id=%s", (dataset,)
	)
	assert result(db, dataset, *columns) == (True, '2022-07-19', '2022-07-19', 'check', ['date'])


def test_prediction_quality_counts_crop_calls_and_never_needs_review(db):
	auditor = create_user(db, can_audit=True)
	dataset = create_dataset(db, create_user(db))
	run = create_run(db, dataset, register_version(db, 'prediction_quality', 'pq-test', rule_config=CUTS))
	crops = [create_crop(db, dataset, x0=512 * i) for i in range(4)]
	# per crop: (luna verdict, likelihood), (haiku verdict, likelihood); haiku cannot assess crop 3
	answers = [(('major', 80), ('major', 60)), (('minor', 30), ('ok', 10)), (('major', 70), ('ok', 20)), (('ok', 0), ('major', 99))]
	for crop, ((luna, luna_p), (haiku, haiku_p)) in zip(crops, answers):
		judge(db, dataset, run, crop, 'luna', 'image', 'ok')
		judge(db, dataset, run, crop, 'haiku', 'image', 'major' if crop == crops[3] else 'ok')
		judge(db, dataset, run, crop, 'luna', 'deadwood', luna, luna_p)
		judge(db, dataset, run, crop, 'haiku', 'deadwood', haiku, haiku_p)
		judge(db, dataset, run, crop, 'luna', 'forest_cover', 'ok', 0)
		judge(db, dataset, run, crop, 'haiku', 'forest_cover', 'ok', 0)
	counts = ('deadwood_total', 'deadwood_major', 'deadwood_minor', 'deadwood_ok', 'forest_cover_total', 'forest_cover_ok')
	# Haiku decides: major, ok, ok on crops 0 to 2; it could not assess crop 3, which has no call
	assert result(db, dataset, *counts) == (3, 1, 0, 2, 3, 3)
	# crop 2: Luna says major, Haiku ok; the layers are reviewed on a sample instead
	assert result(db, dataset, 'review_required', 'checks_run') == ([], ['prediction_quality'])
	# a reviewer's crop decisions, ambiguous too, never send the layer to review
	answer(db, auditor, dataset, 'prediction_quality', 'deadwood', run, verdict='ambiguous', crop=crops[0])
	answer(db, auditor, dataset, 'prediction_quality', 'deadwood', run, verdict='ok', crop=crops[1])
	assert result(db, dataset, 'review_required') == ([],)


def test_aoi_review_and_benchmark_membership(db):
	operator = create_operator(db)
	dataset, unfinished = create_dataset(db, create_user(db)), create_dataset(db, create_user(db))
	finished(db, dataset)
	assert result(db, dataset, 'is_processing_done', 'aoi_exists', 'review_required', 'in_benchmark') == (
		True,
		False,
		['aoi'],
		False,
	)
	assert result(db, unfinished, 'is_processing_done', 'review_required') == (False, [])
	db.execute(
		"INSERT INTO public.v2_aois(dataset_id,user_id,geometry,source,model_version,notes) "
		"VALUES (%s,%s,'{}','ml_prediction','aoi_segmentation_v1','Auto-generated by aoi_segmentation_v1')",
		(dataset, operator),
	)
	act_as(db, operator)
	db.execute("SELECT audit.add_benchmark_target('dataset_evaluation', %s, NULL)", (dataset,))
	assert result(db, dataset, 'aoi_exists', 'aoi_source', 'aoi_model_version', 'review_required', 'in_benchmark') == (
		True,
		'ml_prediction',
		'aoi_segmentation_v1',
		[],
		True,
	)


def test_only_audit_readers_see_the_results(db):
	owner, auditor = create_user(db), create_user(db, can_audit=True)
	dataset = create_dataset(db, owner)
	evaluation_run(db, dataset, 'major')
	query = 'SELECT evaluation_decision, checks_run FROM audit.dataset_results WHERE dataset_id=%s'
	act_as(db, auditor)
	assert db.execute(query, (dataset,)).fetchone() == ('exclude', ['dataset_evaluation'])
	# others read their visible datasets without a single audit row
	act_as(db, owner)
	assert db.execute(query, (dataset,)).fetchone() == (None, [])
	act_as_anon(db)
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute(query, (dataset,))
	as_admin(db)
	db.execute('SET LOCAL ROLE analyst')
	assert db.execute(query, (dataset,)).fetchone() == ('exclude', ['dataset_evaluation'])
