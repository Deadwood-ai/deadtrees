"""Audit Review results, worked out on read: tile calls, the evaluation decision, the reviews that
count, dataset_outcomes with review_required, the public surface and the dataset page's summary."""

from datetime import date

import psycopg

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
	add_labels,
	add_rules,
	create_run,
	dataset_judgement,
	finish,
	pq_run,
	raises,
	register_version,
	tile_ids,
	tile_judgement,
)
from api.tests.db.test_georef_checks import write_check


def outcome(db, dataset, *columns):
	as_admin(db)
	return db.execute(f'SELECT {", ".join(columns)} FROM audit.dataset_outcomes WHERE dataset_id=%s', (dataset,)).fetchone()


def calls(db, dataset, layer='deadwood'):
	as_admin(db)
	return db.execute(
		'SELECT verdict::text, by_person FROM audit.tile_calls WHERE dataset_id=%s AND layer=%s ORDER BY tile_id', (dataset, layer)
	).fetchall()


def add_ortho(db, dataset, sha='a' * 64):
	as_admin(db)
	db.execute(
		'INSERT INTO public.v2_orthos (dataset_id,ortho_file_name,version,ortho_file_size,bbox,sha256,ortho_upload_runtime) '
		"VALUES (%s,'o.tif',1,1,'BOX(7.80 48.00,7.81 48.01)',%s,0.1) "
		'ON CONFLICT (dataset_id) DO UPDATE SET sha256=excluded.sha256',
		(dataset, sha),
	)


def review(db, user, dataset, check='dataset_evaluation', **columns):
	columns = {'decision': 'keep', **columns} if check == 'dataset_evaluation' else columns
	act_as(db, user)
	names = ','.join(columns)
	db.execute(
		f'INSERT INTO audit.dataset_human_reviews(dataset_id,check_key,{names}) VALUES (%s,%s{",%s" * len(columns)})',
		(dataset, check, *columns.values()),
	)
	as_admin(db)


def tile_review(db, user, dataset, tile_id, label, verdict, layer='deadwood'):
	act_as(db, user)
	db.execute(
		'INSERT INTO audit.tile_human_reviews(dataset_id,tile_id,layer,prediction_label_id,verdict) VALUES (%s,%s,%s,%s,%s)',
		(dataset, tile_id, layer, label, verdict),
	)
	as_admin(db)


def legacy(db, dataset, decision):
	as_admin(db)
	db.execute(
		"INSERT INTO audit.legacy_decisions(dataset_id,decision,decided_at) VALUES (%s,%s,now() - interval '1 year')",
		(dataset, decision),
	)


def evaluation(db, dataset, verdict, version_id=None, **evidence):
	"""A done dataset evaluation run whose deciding judge (Haiku) answers verdict (None: no answer)."""
	version_id = version_id or register_version(db, 'dataset_evaluation', f'de-{dataset}-{verdict}')
	judgements = [dataset_judgement('luna-medium', 'ok')]
	if verdict:
		judgements.append(dataset_judgement('haiku-5.5', verdict, cog=True, reason='blurry' if verdict == 'major' else None))
	return finish(db, create_run(db, dataset, version_id, check='dataset_evaluation'), dataset_judgements=judgements, evidence=evidence)


def decision(db, dataset):
	as_admin(db)
	return db.execute(
		'SELECT decision::text, source FROM audit.evaluation_decisions WHERE dataset_id=%s', (dataset,)
	).fetchone()


# ---------------------------------------------------------------------------
# Tile calls
# ---------------------------------------------------------------------------


def test_the_deciding_judge_makes_the_call_and_a_persons_review_of_that_prediction_wins(db):
	auditor, dataset = create_user(db, can_audit=True), create_dataset(db, create_user(db))
	labels = add_labels(db, dataset)
	version = register_version(db, version='pq-calls')
	run = pq_run(
		db,
		dataset,
		version,
		labels,
		[
			tile_judgement(1, 'deadwood', 'haiku-5.5', 'major'),
			tile_judgement(1, 'deadwood', 'luna-medium', 'ok'),
			# a judge that could not assess the tile makes no call; the others never count
			tile_judgement(2, 'deadwood', 'haiku-5.5', 'not_assessable'),
			tile_judgement(2, 'deadwood', 'luna-medium', 'major'),
			# ambiguous is shown and counts for no side
			tile_judgement(3, 'deadwood', 'haiku-5.5', 'ambiguous'),
			tile_judgement(4, 'deadwood', 'luna-medium', 'minor'),
		],
	)
	tiles = tile_ids(db, run)
	assert calls(db, dataset) == [('major', False), (None, False), ('ambiguous', False), (None, False)]
	assert outcome(db, dataset, 'deadwood_total', 'deadwood_major', 'deadwood_minor', 'deadwood_ok') == (1, 1, 0, 0)

	# a person's answer on the prediction the run judged wins; one on another prediction does not
	tile_review(db, auditor, dataset, tiles[0], labels['deadwood'], 'minor')
	tile_review(db, auditor, dataset, tiles[1], labels['forest_cover'], 'ok')
	assert calls(db, dataset)[:2] == [('minor', True), (None, False)]
	assert outcome(db, dataset, 'deadwood_total', 'deadwood_major', 'deadwood_minor') == (1, 0, 1)
	tile_review(db, auditor, dataset, tiles[1], labels['deadwood'], 'ok')
	assert outcome(db, dataset, 'deadwood_total', 'deadwood_ok', 'review_required') == (2, 1, [])
	# a person who can't tell what a tile shows answers ambiguous; can't assess is a model's answer
	act_as(db, auditor)
	raises(
		db,
		psycopg.errors.CheckViolation,
		'INSERT INTO audit.tile_human_reviews(dataset_id,tile_id,layer,prediction_label_id,verdict) VALUES (%s,%s,%s,%s,%s)',
		(dataset, tiles[2], 'deadwood', labels['deadwood'], 'not_assessable'),
	)
	as_admin(db)

	# a new prediction is judged again: the reviews of the old one stop counting, the tiles stay
	new_labels = add_labels(db, dataset)
	rerun = pq_run(
		db,
		dataset,
		version,
		new_labels,
		[tile_judgement(1, 'deadwood', 'haiku-5.5', 'major'), tile_judgement(2, 'deadwood', 'haiku-5.5', 'ok')],
	)
	assert tile_ids(db, rerun) == tiles[:2]
	assert calls(db, dataset) == [('major', False), ('ok', False)]
	assert db.execute(
		'SELECT count(*) FROM audit.tile_human_reviews WHERE dataset_id=%s', (dataset,)
	).fetchone() == (3,)


def test_new_rules_rework_every_result_without_a_rerun(db):
	dataset = create_dataset(db, create_user(db))
	labels = add_labels(db, dataset)
	version = register_version(db, version='pq-rules')
	pq_run(
		db,
		dataset,
		version,
		labels,
		[tile_judgement(1, 'deadwood', 'haiku-5.5', 'ok'), tile_judgement(1, 'deadwood', 'luna-medium', 'major')],
	)
	evaluation_version = register_version(db, 'dataset_evaluation', 'de-rules')
	other = create_dataset(db, create_user(db))
	evaluation(db, other, 'ok', evaluation_version)
	assert calls(db, dataset) == [('ok', False)]
	assert decision(db, other) == ('keep', 'check')

	as_admin(db)
	db.execute('SELECT audit.activate_rules(%s)', (add_rules(db, version, {'decider': 'luna'}, name='rules-luna'),))
	db.execute(
		'SELECT audit.activate_rules(%s)',
		(add_rules(db, evaluation_version, {'decider': 'luna', 'band_major_at': 90}, name='rules-luna'),),
	)
	assert calls(db, dataset) == [('major', False)]
	# the dataset evaluation's luna said ok too (see evaluation()); rules naming no judge decide nothing
	assert decision(db, other) == ('keep', 'check')
	db.execute(
		'SELECT audit.activate_rules(%s)',
		(add_rules(db, evaluation_version, {'decider': 'nobody', 'band_major_at': 90}, name='rules-none'),),
	)
	assert decision(db, other) == (None, None)
	assert outcome(db, other, 'review_required') == (['evaluation'],)


# ---------------------------------------------------------------------------
# The evaluation decision
# ---------------------------------------------------------------------------


def test_a_review_beats_a_legacy_keep_which_beats_the_check_which_beats_a_legacy_exclusion(db):
	auditor, owner = create_user(db, can_audit=True), create_user(db)
	only_legacy, check_lifts, legacy_keeps, reviewer, stale = (create_dataset(db, owner) for _ in range(5))
	for dataset in (only_legacy, check_lifts, stale):
		legacy(db, dataset, 'exclude')
	for dataset in (legacy_keeps, reviewer):
		legacy(db, dataset, 'keep')
	evaluation(db, check_lifts, 'minor')
	for dataset in (legacy_keeps, reviewer):
		evaluation(db, dataset, 'major')
	add_ortho(db, reviewer)
	review(db, auditor, reviewer, decision='exclude', exclude_reason='blurry')
	add_ortho(db, stale)
	review(db, auditor, stale, decision='keep')

	assert [decision(db, d) for d in (only_legacy, check_lifts, legacy_keeps, reviewer, stale)] == [
		('exclude', 'legacy'),
		('keep', 'check'),
		('keep', 'legacy'),
		('exclude', 'reviewer'),
		('keep', 'reviewer'),
	]
	# a review given on another ortho no longer counts
	add_ortho(db, stale, 'b' * 64)
	assert decision(db, stale) == ('exclude', 'legacy')
	assert db.execute(
		"SELECT stale FROM audit.current_dataset_human_reviews WHERE dataset_id=%s AND check_key='dataset_evaluation'", (stale,)
	).fetchone() == (True,)
	ids = [only_legacy, check_lifts, legacy_keeps, reviewer, stale]
	assert db.execute(
		'SELECT array_agg(i ORDER BY i) FROM audit.excluded_dataset_ids() i WHERE i = ANY(%s)', (ids,)
	).fetchone() == (sorted([only_legacy, reviewer, stale]),)
	assert db.execute('SELECT audit.is_dataset_excluded(%s), audit.is_dataset_excluded(%s)', (reviewer, check_lifts)).fetchone() == (
		True,
		False,
	)
	assert outcome(db, reviewer, 'evaluation_decision', 'evaluation_source', 'cog_issue') == ('exclude', 'reviewer', True)


def test_an_unsure_check_needs_a_review_until_one_counts(db):
	auditor, dataset = create_user(db, can_audit=True), create_dataset(db, create_user(db))
	add_ortho(db, dataset)
	evaluation(db, dataset, 'not_assessable')
	assert decision(db, dataset) == (None, None)
	assert outcome(db, dataset, 'review_required') == (['evaluation'],)
	review(db, auditor, dataset, cog_issue=True)
	assert outcome(db, dataset, 'review_required', 'evaluation_decision', 'cog_issue') == ([], 'keep', True)
	# a new ortho: the review stops counting and the dataset is back in the list
	add_ortho(db, dataset, 'c' * 64)
	assert outcome(db, dataset, 'review_required', 'evaluation_decision') == (['evaluation'], None)


# ---------------------------------------------------------------------------
# Georeferencing and the date
# ---------------------------------------------------------------------------


def test_a_georef_review_settles_needs_review_while_the_ortho_is_the_same(db):
	auditor, dataset = create_user(db, can_audit=True), create_dataset(db, create_user(db))
	add_ortho(db, dataset)
	write_check(db, dataset, 'uncertain', 'conflict')
	assert outcome(db, dataset, 'georef_status', 'georef_source', 'review_required') == ('needs_review', 'check', ['georef'])
	review(db, auditor, dataset, 'georef', georef_status='passed')
	assert outcome(db, dataset, 'georef_status', 'georef_source', 'review_required') == ('passed', 'reviewer', [])
	# a georeferencing rerun keeps the review (same ortho); a new ortho does not
	write_check(db, dataset, 'uncertain', 'insufficient')
	assert outcome(db, dataset, 'georef_status', 'review_required') == ('passed', [])
	add_ortho(db, dataset, 'd' * 64)
	assert outcome(db, dataset, 'georef_status', 'georef_source', 'review_required') == ('needs_review', 'check', ['georef'])


def test_a_date_review_holds_while_the_advice_is_the_same_and_reopens_when_it_flips(db):
	auditor, dataset = create_user(db, can_audit=True), create_dataset(db, create_user(db))
	upsert_estimate(db, dataset)  # a confident mismatch: the advice is replace
	assert outcome(db, dataset, 'date_replace', 'date_new', 'review_required') == (True, date(2022, 7, 19), [])
	review(db, auditor, dataset, 'acquisition_date', date_replace=False, note='the recorded date is the flight date')
	assert outcome(db, dataset, 'date_replace', 'date_new', 'review_required') == (False, None, [])
	# the model dates the dataset again with the same advice: the review still counts
	upsert_estimate(db, dataset, suggested='2022-07-25')
	assert outcome(db, dataset, 'date_replace', 'review_required') == (False, [])
	# the advice flips to keep: the review was given on other advice and asks for a person again
	upsert_estimate(db, dataset, mismatch=False, suggested=None)
	assert outcome(db, dataset, 'date_replace', 'review_required') == (False, ['date'])
	review(db, auditor, dataset, 'acquisition_date', date_replace=True, note='leaf-off, so spring')
	assert outcome(db, dataset, 'date_replace', 'date_new', 'review_required') == (True, date(2022, 7, 19), [])
	# the check never changes the dataset's date
	assert db.execute(
		'SELECT aquisition_year, aquisition_month, aquisition_day FROM public.v2_datasets WHERE id=%s', (dataset,)
	).fetchone() == (2022, 3, 11)


# ---------------------------------------------------------------------------
# One row per dataset, the public surface and the dataset page
# ---------------------------------------------------------------------------


def test_aoi_review_and_benchmark_ticks(db):
	operator, dataset = create_user(db, can_audit=True), create_dataset(db, create_user(db))
	db.execute('UPDATE public.privileged_users SET can_operate=true WHERE user_id=%s', (operator,))
	db.execute(
		'INSERT INTO public.v2_statuses(dataset_id,current_status,is_cog_done,is_combined_model_done) '
		"VALUES (%s,'idle',true,true)",
		(dataset,),
	)
	assert outcome(db, dataset, 'is_processing_done', 'review_required', 'in_benchmark') == (True, ['aoi'], False)
	review(db, operator, dataset, in_benchmark=True)
	assert outcome(db, dataset, 'in_benchmark') == (True,)


def test_an_excluded_dataset_needs_no_review(db):
	auditor, dataset = create_user(db, can_audit=True), create_dataset(db, create_user(db))
	add_ortho(db, dataset)
	db.execute(
		'INSERT INTO public.v2_statuses(dataset_id,current_status,is_cog_done,is_combined_model_done) '
		"VALUES (%s,'idle',true,true)",
		(dataset,),
	)
	assert outcome(db, dataset, 'review_required') == (['aoi'],)
	# once excluded, the missing AOI no longer matters
	review(db, auditor, dataset, decision='exclude', exclude_reason='other')
	assert outcome(db, dataset, 'evaluation_decision', 'review_required') == ('exclude', [])
	review(db, auditor, dataset, decision='keep')
	assert outcome(db, dataset, 'review_required') == (['aoi'],)


def test_deleting_a_reviewers_account_keeps_their_reviews(db):
	auditor, dataset = create_user(db, can_audit=True), create_dataset(db, create_user(db))
	add_ortho(db, dataset)
	review(db, auditor, dataset, decision='exclude', exclude_reason='other')
	db.execute('DELETE FROM auth.users WHERE id=%s', (auditor,))
	assert db.execute(
		'SELECT decision::text, reviewed_by FROM audit.dataset_human_reviews WHERE dataset_id=%s', (dataset,)
	).fetchall() == [('exclude', None)]
	assert decision(db, dataset)[0] == 'exclude'


def test_exclusion_hides_a_dataset_from_the_public_surface_only_by_its_decision(db):
	owner, auditor = create_user(db), create_user(db, can_audit=True)
	excluded, kept = create_dataset(db, owner), create_dataset(db, owner)
	legacy(db, excluded, 'exclude')
	evaluation(db, kept, 'major')
	review(db, auditor, kept)
	ids = (excluded, kept)
	act_as_anon(db)
	public = 'SELECT array_agg(id ORDER BY id) FROM public.v2_full_dataset_view_public WHERE id IN (%s,%s)'
	assert db.execute(public, ids).fetchone() == ([kept],)
	assert db.execute(
		'SELECT internal.is_dataset_excluded_from_public_surface(%s), internal.is_dataset_excluded_from_public_surface(%s)', ids
	).fetchone() == (True, False)
	assert db.execute('SELECT audit_decision, is_audited FROM public.v2_full_dataset_view WHERE id=%s', (kept,)).fetchone() == (
		None,
		False,
	)
	# the owner sees the decision on their own dataset; auditors see every decision
	act_as(db, owner)
	assert db.execute(
		'SELECT array_agg(audit_decision ORDER BY id) FROM public.v2_full_dataset_view_owner WHERE id IN (%s,%s)', ids
	).fetchone() == (['exclude', 'keep'],)
	assert db.execute('SELECT public.get_dataset_status_details(%s)', (excluded,)).fetchone()[0]['audit_decision'] == 'exclude'
	act_as(db, auditor)
	assert db.execute('SELECT audit_decision, is_audited FROM public.v2_full_dataset_view WHERE id=%s', (kept,)).fetchone() == (
		'keep',
		True,
	)
	# the check lifts the legacy exclusion once it decides
	evaluation(db, excluded, 'ok')
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


def test_the_dataset_page_summary_shows_the_outcome_and_the_deciding_models_reasoning(db):
	auditor, owner = create_user(db, can_audit=True), create_user(db)
	dataset, private = create_dataset(db, owner), create_dataset(db, owner, access='private')
	labels = add_labels(db, dataset)
	legacy(db, dataset, 'keep')
	upsert_estimate(db, dataset)
	run = pq_run(
		db,
		dataset,
		register_version(db, version='pq-summary'),
		labels,
		[
			tile_judgement(1, 'deadwood', 'haiku-5.5', 'major', summary='Dead crowns are missed.'),
			tile_judgement(1, 'deadwood', 'luna-medium', 'minor', summary='Luna says minor.'),
			tile_judgement(2, 'deadwood', 'haiku-5.5', 'minor', errors=['m1: a snag at x 520-625, y 60-210 has no blue']),
			tile_judgement(3, 'deadwood', 'haiku-5.5', 'major', summary='Overruled by a person.'),
			tile_judgement(1, 'forest_cover', 'haiku-5.5', 'ok', summary='Fine.'),
		],
	)
	tile_review(db, auditor, dataset, tile_ids(db, run)[2], labels['deadwood'], 'ok')
	act_as_anon(db)
	summary = db.execute('SELECT public.get_dataset_audit_summary(%s)', (dataset,)).fetchone()[0]
	assert summary == {
		'review_required': [],
		'evaluation_decision': 'keep',
		'georef_status': None,
		'georef_offset_m': None,
		'date_replace': True,
		'date_new': '2022-07-19',
		'deadwood_total': 3,
		'deadwood_major': 1,
		'deadwood_minor': 1,
		'deadwood_reasoning': [
			{'verdict': 'major', 'summary': 'Dead crowns are missed.', 'errors': []},
			{'verdict': 'minor', 'summary': None, 'errors': ['m1: a snag at x 520-625, y 60-210 has no blue']},
		],
		'forest_cover_total': 1,
		'forest_cover_major': 0,
		'forest_cover_minor': 0,
		'forest_cover_reasoning': [],
	}
	# a dataset the caller cannot see has no summary
	assert db.execute('SELECT public.get_dataset_audit_summary(%s)', (private,)).fetchone() == (None,)


def test_only_audit_readers_see_the_results(db):
	user, auditor, dataset = create_user(db), create_user(db, can_audit=True), create_dataset(db, create_user(db))
	legacy(db, dataset, 'exclude')
	for view in ('evaluation_decisions', 'current_dataset_human_reviews', 'tile_calls', 'evaluation_calls'):
		act_as(db, user)
		assert db.execute(f'SELECT count(*) FROM audit.{view} WHERE dataset_id=%s', (dataset,)).fetchone() == (0,), view
		act_as(db, auditor)
		db.execute(f'SELECT * FROM audit.{view} WHERE dataset_id=%s', (dataset,)).fetchall()
	# a user who sees the dataset sees its row, without anything the audit found
	act_as(db, user)
	assert db.execute('SELECT evaluation_decision FROM audit.dataset_outcomes WHERE dataset_id=%s', (dataset,)).fetchone() == (None,)
	act_as(db, auditor)
	assert db.execute('SELECT evaluation_decision FROM audit.dataset_outcomes WHERE dataset_id=%s', (dataset,)).fetchone() == (
		'exclude',
	)
	act_as_anon(db)
	raises(db, psycopg.errors.InsufficientPrivilege, 'SELECT audit.is_dataset_excluded(%s)', (dataset,))


# ---------------------------------------------------------------------------
# The Audit Review list, paged on the server
# ---------------------------------------------------------------------------


def test_the_review_list_filters_counts_and_pages_on_the_server(db):
	auditor, user, owner = create_user(db, can_audit=True), create_user(db), create_user(db)
	excluded, pending, failed, archived = (create_dataset(db, owner) for _ in range(4))
	ids = [excluded, pending, failed, archived]
	as_admin(db)
	db.execute('UPDATE public.v2_datasets SET archived=true WHERE id=%s', (archived,))
	db.execute(
		'INSERT INTO public.v2_statuses(dataset_id,current_status,is_cog_done,is_combined_model_done,has_error,error_stage,error_message) VALUES '
		"(%s,'cog_processing',false,false,false,null,null),(%s,'idle',true,true,false,null,null),(%s,'idle',false,false,true,'cog','gdal broke')",
		(excluded, pending, failed),
	)
	db.execute(
		'INSERT INTO public.v2_metadata(dataset_id,metadata,version) VALUES (%s,%s,1)',
		(pending, '{"gadm": {"admin_level_1": "Listland", "admin_level_3": "Listtown"}}'),
	)
	db.execute("INSERT INTO public.dataset_flags(dataset_id,created_by,description,status) VALUES (%s,%s,'seam','open')", (pending, user))
	db.execute('INSERT INTO public.reference_datasets(dataset_id) VALUES (%s)', (failed,))
	legacy(db, excluded, 'exclude')
	labels = add_labels(db, pending)
	pq_run(
		db,
		pending,
		register_version(db, version='pq-list'),
		labels,
		[tile_judgement(1, 'deadwood', 'haiku-5.5', 'major'), tile_judgement(2, 'deadwood', 'haiku-5.5', 'ok')],
	)
	review(db, auditor, pending, 'georef', georef_status='passed')

	def rows(where='true', columns='dataset_id'):
		act_as(db, auditor)
		return db.execute(
			f'SELECT {columns} FROM audit.review_list WHERE dataset_id = ANY(%s) AND {where} ORDER BY dataset_id DESC', (ids,)
		).fetchall()

	# archived datasets are not listed; the tabs and filters are plain conditions
	assert rows() == [(failed,), (pending,), (excluded,)]
	assert rows("review_required <> '{}'") == rows("review_required @> '{aoi}'") == [(pending,)]
	assert rows('flags > 0 OR edits > 0') == [(pending,)]
	assert rows('reference') == [(failed,)]
	assert rows("evaluation_decision = 'exclude'") == [(excluded,)]
	assert rows('major_share >= 50') == rows("admin_level_1 = 'Listland'") == [(pending,)]
	act_as(db, auditor)
	assert db.execute(
		'SELECT dataset_id FROM audit.review_list WHERE dataset_id = ANY(%s) AND reviewers @> %s', (ids, [auditor])
	).fetchall() == [(pending,)]
	# not finished leaves out the failed one, which names its stage
	assert rows('NOT is_processing_done AND NOT has_error') == [(excluded,)]
	assert rows('has_error', 'dataset_id, failed_stage, error_message') == [(failed, 'cog_processing', 'gdal broke')]
	assert rows(f'dataset_id = {pending}', 'deadwood_major_share, is_cog_done, flags, edits, (outcome).review_required') == [
		(50, True, 1, 0, ['aoi'])
	]
	# the outcome is the dataset's row of dataset_outcomes
	assert db.execute(
		'SELECT to_jsonb(l.outcome) = to_jsonb(o) FROM audit.review_list l JOIN audit.dataset_outcomes o USING (dataset_id) WHERE dataset_id=%s',
		(pending,),
	).fetchone() == (True,)
	# Save & Next: the next older row of the same list, none after the last
	next_in = 'SELECT dataset_id FROM audit.review_list WHERE dataset_id = ANY(%s) AND {} AND dataset_id < %s ORDER BY dataset_id DESC LIMIT 1'
	assert db.execute(next_in.format('true'), (ids, failed)).fetchone() == (pending,)
	assert db.execute(next_in.format("review_required <> '{}'"), (ids, failed)).fetchone() == (pending,)
	assert db.execute(next_in.format("review_required <> '{}'"), (ids, pending)).fetchone() is None

	# the filters' choices; only auditors see who reviewed
	options = db.execute('SELECT audit.review_list_options()').fetchone()[0]
	assert 'Listland' in options['countries'] and 'cog_processing' in options['stages'] and 'idle' not in options['stages']
	assert {'id': str(auditor), 'email': f'{auditor}@example.invalid'} in options['reviewers']
	act_as(db, user)
	assert db.execute('SELECT audit.review_list_options()').fetchone()[0]['reviewers'] == []
	assert db.execute(
		'SELECT reviewers, evaluation_decision FROM audit.review_list WHERE dataset_id IN (%s,%s) ORDER BY dataset_id', (excluded, pending)
	).fetchall() == [([], None), ([], None)]
