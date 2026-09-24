"""Retained evidence: reconstructed first results, failures and recoveries next to measured facts."""
import json
from datetime import datetime, timedelta, timezone

import psycopg
import pytest

from api.tests.db.test_factory import authenticate, dataset, db, user  # noqa: F401

GIB = 1073741824


def log(db, row, stamp, message, category='process', level='INFO', extra=None):
	db.execute(
		'INSERT INTO public.v2_logs(dataset_id,created_at,level,category,message,extra) VALUES (%s,%s,%s,%s,%s,%s)',
		(row, stamp, level, category, message, json.dumps(extra) if extra else None),
	)


def log_upload(db, row, stamp, size=GIB // 2):
	log(db, row, stamp, f'Upload completed successfully for dataset {row}', 'upload', extra={'file_size': size})


def run(db, row, start, *, result=True, fail=False, interrupt=False, minutes=30):
	"""One processor run in the shapes the processor logs: start, stage successes, then a failure or the end."""
	log(db, row, start, f'Starting processing for task {row}')
	log(db, row, start + timedelta(minutes=5), 'Processed metadata successfully', 'metadata')
	if result:
		log(db, row, start + timedelta(minutes=minutes), 'Combined segmentation completed successfully', 'deadwood')
	if interrupt:
		log(db, row, start + timedelta(minutes=minutes + 1), f'Received signal 15; gracefully re-queuing in-flight task {row} for dataset {row} for retry', level='WARNING')
	if fail:
		log(db, row, start + timedelta(minutes=minutes + 1), 'Processing failed: aoi_segmentation processing failed', level='ERROR')
	return start + timedelta(minutes=minutes if result else 5)


@pytest.fixture(autouse=True)
def retained_runs(db):
	"""Processor-run evidence starts long before these scenarios, as in production."""
	anchor = dataset(db, user(db))
	log(db, anchor, datetime(2000, 1, 1, tzinfo=timezone.utc), f'Starting processing for task {anchor}')


def legacy(db, owner, **kwargs):
	"""A dataset registered before measurement began, so only retained logs describe it."""
	row = dataset(db, owner, **kwargs)
	db.execute("UPDATE public.v2_datasets SET created_at='2025-06-01Z' WHERE id=%s", (row,))
	db.execute('DELETE FROM public.factory_submissions WHERE dataset_id=%s', (row,))
	return row


def outcome(db, row):
	return db.execute(
		'SELECT uploaded_at,first_result_at,result_source,input_bytes FROM public.factory_outcome_evidence WHERE dataset_id=%s', (row,)
	).fetchone()


def failures(db, row):
	return db.execute(
		"""SELECT failed_at,recovered_at,start_source,recovery_source,phase FROM public.factory_failure_evidence
		WHERE dataset_id=%s ORDER BY failed_at NULLS LAST""",
		(row,),
	).fetchall()


def trends(db, interval='day', workflow='all', size='all'):
	return db.execute('SELECT public.factory_trends(%s,%s,%s)', (interval, workflow, size)).fetchone()[0]


def bucket(result, stamp):
	return next(b for b in result['series'] if datetime.fromisoformat(b['start']) <= stamp < datetime.fromisoformat(b['end']))


def listed(db, **filters):
	return db.execute('SELECT public.factory_datasets(%s)', (json.dumps(filters),)).fetchone()[0]['total']


def ago(**delta):
	return datetime.now(timezone.utc) - timedelta(**delta)


def test_first_result_is_the_first_run_that_produced_predictions_without_failing(db):
	owner = user(db)
	row = legacy(db, owner)
	uploaded = ago(days=20)
	log_upload(db, row, uploaded)
	failed = run(db, row, uploaded + timedelta(hours=1), fail=True)  # predictions, then AOI failed
	run(db, row, uploaded + timedelta(hours=2), interrupt=True)  # a deploy re-queued the task
	first = run(db, row, uploaded + timedelta(hours=3))
	run(db, row, uploaded + timedelta(days=5))  # a rerun never creates another first result
	assert outcome(db, row)[1:3] == (first, 'processing_log')
	assert failures(db, row) == [(failed + timedelta(minutes=1), first, 'processing_log', 'processing_log', 'first_result')]


def test_consecutive_failed_retries_are_one_episode_and_reruns_are_a_separate_phase(db):
	owner = user(db)
	row = legacy(db, owner)
	uploaded = ago(days=30)
	log_upload(db, row, uploaded)
	first = run(db, row, uploaded + timedelta(hours=1))
	rerun = uploaded + timedelta(days=2)
	run(db, row, rerun, result=False, fail=True)
	run(db, row, uploaded + timedelta(days=3), result=False, fail=True)
	recovered = run(db, row, uploaded + timedelta(days=4), result=False)
	assert outcome(db, row)[1] == first
	assert failures(db, row) == [(rerun + timedelta(minutes=31), recovered, 'processing_log', 'processing_log', 'rerun')]
	# Without upload evidence or an earlier result the phase is not guessed.
	older = legacy(db, owner)
	run(db, older, ago(days=10), result=False, fail=True)
	assert failures(db, older)[0][4] == 'unknown' and outcome(db, older) is None


def test_stage_only_success_does_not_recover_a_dataset_without_a_result(db):
	owner = user(db)
	row = legacy(db, owner)
	uploaded = ago(days=12)
	log_upload(db, row, uploaded)
	first_failure = uploaded + timedelta(hours=1)
	run(db, row, first_failure, result=False, fail=True)
	run(db, row, uploaded + timedelta(days=1), result=False)  # metadata succeeded, still no predictions
	run(db, row, uploaded + timedelta(days=2), result=False, fail=True)  # same broken dataset, same episode
	assert failures(db, row) == [(first_failure + timedelta(minutes=31), None, 'processing_log', None, 'first_result')]
	complete = run(db, row, uploaded + timedelta(days=3))
	assert failures(db, row) == [(first_failure + timedelta(minutes=31), complete, 'processing_log', 'processing_log', 'first_result')]
	assert outcome(db, row)[1] == complete


def test_result_needs_both_predictions_and_is_timed_before_search_indexing(db):
	owner = user(db)
	row = legacy(db, owner)
	uploaded = ago(days=8)
	log_upload(db, row, uploaded)
	# A tree-cover-only rerun of the legacy model is not a complete result.
	start = uploaded + timedelta(hours=1)
	log(db, row, start, f'Starting processing for task {row}')
	log(db, row, start + timedelta(minutes=10), 'Tree cover segmentation completed successfully', 'treecover')
	assert outcome(db, row)[1] is None
	# Both legacy models in one run are; AOI completes it, later indexing does not delay it.
	start = uploaded + timedelta(hours=3)
	log(db, row, start, f'Starting processing for task {row}')
	log(db, row, start + timedelta(minutes=10), 'Deadwood segmentation completed successfully', 'deadwood')
	log(db, row, start + timedelta(minutes=20), 'Tree cover segmentation completed successfully', 'treecover')
	log(db, row, start + timedelta(minutes=25), 'AOI segmentation completed successfully', 'aoi')
	log(db, row, start + timedelta(minutes=40), 'Tile embedding completed successfully', 'embeddings')
	assert outcome(db, row)[1:3] == (start + timedelta(minutes=25), 'processing_log')


def test_uploads_before_the_first_retained_run_get_no_reconstructed_result(db):
	owner = user(db)
	row, later = legacy(db, owner), legacy(db, owner)
	db.execute("UPDATE public.v2_datasets SET created_at='1989-12-31Z' WHERE id IN (%s,%s)", (row, later))
	# This test's run becomes the earliest retained run; its upload predates it.
	log_upload(db, row, datetime(1990, 1, 1, tzinfo=timezone.utc))
	run(db, row, datetime(1990, 1, 2, tzinfo=timezone.utc))
	assert outcome(db, row)[1:3] == (None, None)
	log_upload(db, later, datetime(1990, 1, 3, tzinfo=timezone.utc))
	finished = run(db, later, datetime(1990, 1, 4, tzinfo=timezone.utc))
	assert outcome(db, later)[1:3] == (finished, 'processing_log')


def test_open_failures_stay_open_while_a_requeue_clears_the_error_flag(db):
	operator = user(db, operate=True)
	authenticate(db, operator)
	before = trends(db)['summary']['unresolved_failures']
	db.execute('RESET ROLE')
	row = legacy(db, operator)
	db.execute('UPDATE public.v2_statuses SET has_error=true WHERE dataset_id=%s', (row,))
	db.execute("UPDATE public.v2_statuses SET has_error=false,current_status='cog_processing' WHERE dataset_id=%s", (row,))  # requeued retry
	authenticate(db, operator)
	assert trends(db)['summary']['unresolved_failures'] - before == 1
	assert listed(db, ids=[row], metric='unresolved_failure') == 1


def test_measured_submission_stays_authoritative_while_waiting(db):
	owner = user(db)
	row = dataset(db, owner)
	db.execute('UPDATE public.v2_statuses SET is_upload_done=true,uploaded_input_bytes=%s WHERE dataset_id=%s', (GIB, row))
	run(db, row, ago(minutes=50))  # logs alone cannot complete a measured submission
	uploaded, first, source, size = outcome(db, row)
	assert first is None and source is None and size == GIB
	db.execute('UPDATE public.v2_statuses SET has_error=true WHERE dataset_id=%s', (row,))
	assert [(r[2], r[4]) for r in failures(db, row)] == [('measured', 'first_result')]


def test_older_datasets_are_now_observed_and_carried_failures_keep_their_logged_start(db):
	owner = user(db)
	observed = legacy(db, owner)
	db.execute('UPDATE public.v2_statuses SET has_error=true WHERE dataset_id=%s', (observed,))
	assert [r[2] for r in failures(db, observed)] == ['measured']

	carried = legacy(db, owner)
	log_upload(db, carried, ago(days=40))
	failed = run(db, carried, ago(days=39), fail=True)
	db.execute('UPDATE public.v2_statuses SET has_error=true WHERE dataset_id=%s', (carried,))
	# Simulate the migration's open row for a dataset that was already failing.
	db.execute('UPDATE public.factory_failure_episodes SET failed_at=NULL WHERE dataset_id=%s', (carried,))
	assert failures(db, carried) == [(failed + timedelta(minutes=1), None, 'processing_log', None, 'first_result')]
	db.execute("""UPDATE public.v2_statuses SET has_error=false,current_status='idle',is_upload_done=true,is_ortho_done=true,
	is_metadata_done=true,is_cog_done=true,is_thumbnail_done=true,is_combined_model_done=true WHERE dataset_id=%s""", (carried,))
	[(start, recovered, start_source, recovery_source, phase)] = failures(db, carried)
	assert start == failed + timedelta(minutes=1) and recovered is not None and recovery_source == 'measured'

	unknown = legacy(db, owner)
	db.execute('UPDATE public.v2_statuses SET has_error=true WHERE dataset_id=%s', (unknown,))
	db.execute('UPDATE public.factory_failure_episodes SET failed_at=NULL WHERE dataset_id=%s', (unknown,))
	assert failures(db, unknown) == [(None, None, None, None, 'unknown')]


def test_trend_buckets_count_each_dataset_once_with_sources_and_matching_links(db):
	operator = user(db, operate=True)
	day = ago(days=9)
	authenticate(db, operator)
	before = bucket(trends(db, workflow='odm', size='large'), day)
	db.execute('RESET ROLE')
	quick, stuck = legacy(db, operator, file_name='quick.zip'), legacy(db, operator, file_name='stuck.zip')
	for row in (quick, stuck):
		log_upload(db, row, day, size=4 * GIB)
	run(db, quick, day + timedelta(hours=1), minutes=60)
	run(db, quick, day + timedelta(hours=4))  # rerun
	run(db, stuck, day + timedelta(hours=1), result=False, fail=True)
	authenticate(db, operator)
	after = bucket(trends(db, workflow='odm', size='large'), day)
	def added(key):
		return (after[key] or 0) - (before[key] or 0)

	assert added('uploaded') == 2 and added('uploaded_measured') == 0
	assert added('first_ready') == 1 and added('first_ready_measured') == 0
	assert added('failures_first_result') == 1 and added('completed_input_gib') == 4
	if not before['first_ready']:
		assert after['lead_p50_hours'] == 2
	for metric, expected in [('uploaded', 2), ('first_ready', 1), ('failures', 1), ('first_result_failures', 1)]:
		bounds = dict(metric=metric, metric_after=after['start'], metric_before=after['end'], archived='all', workflow='odm', size='large')
		assert listed(db, ids=[quick, stuck], **bounds) == expected
	assert listed(db, ids=[quick, stuck], metric='uploaded', size='small', archived='all') == 0


def test_summary_waits_on_uploads_without_a_result_and_links_the_same_datasets(db):
	operator = user(db, operate=True)
	waiting = legacy(db, operator, is_upload_done=True)
	log_upload(db, waiting, ago(days=3))
	run(db, waiting, ago(days=3) + timedelta(minutes=10), result=False, fail=True)
	db.execute('UPDATE public.v2_statuses SET has_error=true WHERE dataset_id=%s', (waiting,))
	complete_now = legacy(db, operator, is_upload_done=True)
	log_upload(db, complete_now, ago(days=3))
	db.execute("""UPDATE public.v2_statuses SET current_status='idle',is_ortho_done=true,is_metadata_done=true,is_cog_done=true,
	is_thumbnail_done=true,is_combined_model_done=true WHERE dataset_id=%s""", (complete_now,))
	authenticate(db, operator)
	summary = trends(db)['summary']
	assert summary['waiting'] >= 1 and summary['waiting_failed'] >= 1 and summary['oldest_wait_hours'] > 71.9
	assert summary['unresolved_first_result'] >= 1 and summary['unrecorded_results'] >= 1
	assert listed(db, ids=[waiting, complete_now], metric='waiting') == 1
	assert listed(db, ids=[waiting, complete_now], metric='failed_submission') == 1
	assert listed(db, ids=[waiting, complete_now], metric='unresolved_failure') == 1


@pytest.mark.parametrize('interval,count,step', [('day', 28, timedelta(days=1)), ('week', 12, timedelta(days=7)), ('month', 12, None)])
def test_intervals_and_periods_before_evidence_are_unknown(db, interval, count, step):
	authenticate(db, user(db, operate=True))
	result = trends(db, interval)
	assert len(result['series']) == count and result['series'][-1]['partial'] is True
	for point in result['series']:
		start, end = datetime.fromisoformat(point['start']), datetime.fromisoformat(point['end'])
		assert start.utcoffset() == timedelta(0) and start.hour == 0
		assert step is None and start.day == 1 or end - start == step
		upload_since = result['upload_since'] and datetime.fromisoformat(result['upload_since'])
		run_since = result['run_since'] and datetime.fromisoformat(result['run_since'])
		assert (point['uploaded'] is None) == (not upload_since or end <= upload_since)
		assert (point['first_ready'] is None) == (not run_since or end <= run_since)
		assert (point['failures_first_result'] is None) == (point['first_ready'] is None)


def test_detail_shows_first_result_and_failure_evidence(db):
	operator = user(db, operate=True)
	row = legacy(db, operator)
	log_upload(db, row, ago(days=5))
	failed = run(db, row, ago(days=5) + timedelta(hours=1), fail=True)
	first = run(db, row, ago(days=4))
	authenticate(db, operator)
	detail = db.execute('SELECT public.factory_dataset(%s)', (row,)).fetchone()[0]
	assert detail['status']['first_result_source'] == 'processing_log'
	assert datetime.fromisoformat(detail['status']['first_result_at']) == first
	assert [datetime.fromisoformat(f['failed_at']) for f in detail['failures']] == [failed + timedelta(minutes=1)]
	assert detail['failures'][0]['phase'] == 'first_result'


@pytest.mark.parametrize('relation', ['factory_processing_runs', 'factory_outcome_evidence', 'factory_failure_evidence'])
def test_evidence_views_are_private(db, relation):
	authenticate(db, user(db, operate=True))
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute(f'SELECT * FROM public.{relation}')


def test_run_reconstruction_reads_a_targeted_index(db):
	from api.tests.db.test_factory_query_plans import walk_plan
	# Realistic shape: run evidence is a small share of logs. The transaction rolls back.
	noisy = dataset(db, user(db))
	db.execute("""INSERT INTO public.v2_logs(dataset_id,level,category,message)
	SELECT %s,'INFO','noise','synthetic noise '||i FROM generate_series(1,20000) i""", (noisy,))
	db.execute('ANALYZE public.v2_logs')
	db.execute('SET LOCAL enable_seqscan=off')
	plan = db.execute('EXPLAIN (FORMAT JSON) SELECT * FROM public.factory_processing_runs WHERE dataset_id=%s', (123,)).fetchone()[0][0]['Plan']
	assert any(n.get('Index Name') == 'factory_run_log_idx' and '123' in n.get('Index Cond', '') for n in walk_plan(plan))
