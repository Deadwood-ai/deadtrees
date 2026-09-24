"""North-star outcomes: weekly funnel, reach, reuse and cohorts without the team."""
from datetime import timedelta

import psycopg
import pytest
from psycopg import sql

from api.tests.db.test_factory import authenticate, dataset, db, user  # noqa: F401
from api.tests.db.test_factory_retained_outcomes import log_upload, run


def north_star(db, operator, include_team=False):
	authenticate(db, operator)
	result = db.execute('SELECT public.factory_north_star(%s)', (include_team,)).fetchone()[0]
	db.execute('RESET ROLE')
	return result


def at(db, bucket_start, offset):
	return db.execute('SELECT %s::timestamptz + %s::interval', (bucket_start, offset)).fetchone()[0]


def upload(db, owner, uploaded_at, file_name='north-star.tif', **status):
	"""A legacy-style upload with retained upload-log evidence at its registration time."""
	row = dataset(db, owner, file_name=file_name)
	db.execute('UPDATE public.v2_datasets SET created_at=%s WHERE id=%s', (uploaded_at, row))
	status = {'is_upload_done': True, **status}
	for key, value in status.items():
		db.execute(sql.SQL('UPDATE public.v2_statuses SET {}=%s WHERE dataset_id=%s').format(sql.Identifier(key)), (value, row))
	# Instrumentation may observe the flag change; keep this upload on the evidence path.
	db.execute('DELETE FROM public.factory_submissions WHERE dataset_id=%s', (row,))
	log_upload(db, row, uploaded_at)
	return row


def completed(db, row, finished_at):
	"""A processor run that produced the first predictions, ending at finished_at."""
	run(db, row, finished_at - timedelta(minutes=30))


def week(result, index):
	return result['weekly'][index]


def delta(before, after, key, index):
	return (week(after, index)[key] or 0) - (week(before, index)[key] or 0)


@pytest.fixture
def operator(db):
	identity = user(db, operate=True)
	anchor = upload(db, identity, db.execute("SELECT now()-interval '120 days'").fetchone()[0])
	# Retained processor runs start no later than the anchor, so recent uploads are observable.
	completed(db, anchor, db.execute("SELECT now()-interval '119 days'").fetchone()[0])
	return identity


def test_requires_operator_permission(db):
	auditor = user(db, audit=True)
	authenticate(db, auditor)
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute('SELECT public.factory_north_star()')


def test_null_team_filter_is_rejected(db, operator):
	authenticate(db, operator)
	with pytest.raises(psycopg.errors.InvalidParameterValue):
		db.execute('SELECT public.factory_north_star(NULL)')


def test_results_reach_and_stalled_stage_exclude_the_team_by_default(db, operator):
	before = north_star(db, operator)
	before_team = north_star(db, operator, include_team=True)
	start = week(before, -4)['start']
	contributor, team = user(db), user(db, audit=True)
	quick = upload(db, contributor, at(db, start, '1 day'))
	completed(db, quick, at(db, start, '1 day 5 hours'))
	upload(db, contributor, at(db, start, '2 days'), is_ortho_done=True, has_error=True)
	late = upload(db, contributor, at(db, start, '2 days'), file_name='late.zip')
	completed(db, late, at(db, start, '10 days'))
	team_row = upload(db, team, at(db, start, '1 day'))
	completed(db, team_row, at(db, start, '1 day 1 hour'))

	after = north_star(db, operator)
	assert delta(before, after, 'uploads', -4) == 3
	assert delta(before, after, 'results', -4) == 1
	assert delta(before, after, 'reach_eligible', -4) == 3
	assert delta(before, after, 'not_reached_7d', -4) == 2
	assert week(after, -4)['geotiff_samples'] - week(before, -4)['geotiff_samples'] == 1
	stalled = {row['step']: row for row in after['stalled']}
	old = {row['step']: row for row in before['stalled']}
	assert stalled['cog']['with_error'] - old.get('cog', {'with_error': 0})['with_error'] == 1
	assert stalled['late']['datasets'] - old.get('late', {'datasets': 0})['datasets'] == 1

	with_team = north_star(db, operator, include_team=True)
	assert delta(before_team, with_team, 'uploads', -4) == 4
	assert delta(before_team, with_team, 'results', -4) == 2


def test_uploads_before_retained_runs_never_count_as_results(db, operator):
	before = north_star(db, operator)
	run_since = before['run_since']
	contributor = user(db)
	earlier = upload(db, contributor, at(db, run_since, '-1 day'))
	completed(db, earlier, at(db, week(before, -2)['start'], '1 day'))
	after = north_star(db, operator)
	assert delta(before, after, 'results', -2) == 0


def test_only_usable_audits_count_as_reference_data(db, operator):
	before = north_star(db, operator)
	start = week(before, -3)['start']
	contributor = user(db)
	for assessment in ('no_issues', 'fixable_issues', 'exclude_completely'):
		row = upload(db, contributor, at(db, start, '-30 days'))
		db.execute(
			'INSERT INTO public.dataset_audit(dataset_id,audit_date,final_assessment,audited_by) VALUES (%s,%s,%s,%s)',
			(row, at(db, start, '1 day'), assessment, operator),
		)
	after = north_star(db, operator)
	assert delta(before, after, 'audited_usable', -3) == 1


def test_downloads_split_reuse_and_skip_team_downloaders(db, operator):
	owner, reuser, team = user(db), user(db), user(db, audit=True)
	row = upload(db, owner, db.execute("SELECT now()-interval '30 days'").fetchone()[0])
	before = north_star(db, operator)
	stamp = at(db, week(before, -2)['start'], '1 day')
	for downloader in (owner, reuser, reuser, team):
		db.execute(
			"INSERT INTO public.dataset_download_requests(dataset_id,user_id,kind,requested_at) VALUES (%s,%s,'dataset',%s)",
			(row, downloader, stamp),
		)
	after = north_star(db, operator)
	assert delta(before, after, 'downloads', -2) == 3
	assert delta(before, after, 'reuse_downloads', -2) == 2


def test_activation_and_retention_cohorts_count_only_elapsed_windows(db, operator):
	before = north_star(db, operator)
	month = before['cohorts'][-5]  # four months ago: both windows have elapsed
	start = month['start']
	activated, idle, batch = user(db), user(db), user(db)
	for identity in (activated, idle, batch):
		db.execute('UPDATE auth.users SET created_at=%s WHERE id=%s', (at(db, start, '1 day'), identity))
	upload(db, activated, at(db, start, '5 days'))
	upload(db, activated, at(db, start, '40 days'))  # returns on a later day within 90 days
	upload(db, batch, at(db, start, '5 days'))
	upload(db, batch, at(db, start, '5 days 1 hour'))  # same batch is not a return
	after = north_star(db, operator)
	cohort, old = after['cohorts'][-5], before['cohorts'][-5]
	assert cohort['activation_eligible'] - old['activation_eligible'] == 3
	assert cohort['activated_30d'] - old['activated_30d'] == 2
	assert cohort['retention_eligible'] - old['retention_eligible'] == 2
	assert cohort['returned_90d'] - old['returned_90d'] == 1
	assert after['cohorts'][-1]['retention_eligible'] == 0


def test_download_requests_are_private(db):
	identity = user(db)
	authenticate(db, identity)
	for statement in (
		'SELECT * FROM public.dataset_download_requests',
		"INSERT INTO public.dataset_download_requests(dataset_id,kind) VALUES (1,'dataset')",
	):
		db.execute('SAVEPOINT denied')
		with pytest.raises(psycopg.errors.InsufficientPrivilege):
			db.execute(statement)
		db.execute('ROLLBACK TO SAVEPOINT denied')
