"""Real local DB contracts for immutable submission metrics and chart drilldowns."""

from datetime import datetime, timedelta, timezone

import psycopg
import pytest

from api.tests.db.test_factory import authenticate, dataset, db, user  # noqa: F401


def upload(db, owner, *, size=1073741824, name='input.tif'):
	row = dataset(db, owner, file_name=name)
	db.execute('UPDATE public.v2_statuses SET is_upload_done=true,uploaded_input_bytes=%s WHERE dataset_id=%s', (size, row))
	return row


def ready(db, row):
	db.execute("""UPDATE public.v2_statuses SET current_status='idle',has_error=false,is_ortho_done=true,
	is_metadata_done=true,is_cog_done=true,is_thumbnail_done=true,is_combined_model_done=true
	WHERE dataset_id=%s""", (row,))


def trends(db, **kwargs):
	return db.execute('SELECT public.factory_trends(%s,%s,%s)',
		(kwargs.get('interval', 'week'), kwargs.get('workflow', 'all'), kwargs.get('size', 'all'))).fetchone()[0]


def test_first_ready_input_once_and_zip_aoi_readiness(db):
	owner = user(db, operate=True)
	row = upload(db, owner, name='input.zip', size=2*1073741824)
	ready(db, row)
	assert db.execute('SELECT first_ready_at FROM public.factory_submissions WHERE dataset_id=%s', (row,)).fetchone()[0] is None
	db.execute('UPDATE public.v2_statuses SET is_odm_done=true,is_aoi_required=true WHERE dataset_id=%s', (row,))
	assert db.execute('SELECT first_ready_at FROM public.factory_submissions WHERE dataset_id=%s', (row,)).fetchone()[0] is None
	db.execute('UPDATE public.v2_statuses SET is_aoi_done=true WHERE dataset_id=%s', (row,))
	first = db.execute('SELECT first_ready_at,input_bytes FROM public.factory_submissions WHERE dataset_id=%s', (row,)).fetchone()
	assert first[0] is not None
	# Enrichment/rerun and rewritten size cannot manufacture another submission.
	db.execute("UPDATE public.v2_statuses SET current_status='cog_processing',uploaded_input_bytes=123 WHERE dataset_id=%s", (row,))
	ready(db, row)
	assert db.execute('SELECT first_ready_at,input_bytes FROM public.factory_submissions WHERE dataset_id=%s', (row,)).fetchone() == first
	authenticate(db, owner)
	detail = db.execute('SELECT public.factory_dataset(%s)', (row,)).fetchone()[0]
	assert detail['status']['input_bytes'] == first[1]
	assert detail['status']['first_ready_at'] is not None
	result = trends(db, workflow='odm', size='large')
	assert result['summary']['first_ready'] >= 1
	matched = db.execute("SELECT public.factory_datasets(%s)", ('{"metric":"first_ready","workflow":"odm","size":"large","archived":"all"}',)).fetchone()[0]
	assert row in [r['dataset_id'] for r in matched['items']]


def test_recovery_needs_whole_pipeline_and_error_retries_one_episode(db):
	owner = user(db)
	row = upload(db, owner)
	db.execute('UPDATE public.v2_statuses SET has_error=true WHERE dataset_id=%s', (row,))
	db.execute('UPDATE public.v2_statuses SET has_error=false WHERE dataset_id=%s', (row,))
	db.execute('UPDATE public.v2_statuses SET has_error=true WHERE dataset_id=%s', (row,))
	assert db.execute('SELECT count(*),max(recovered_at) FROM public.factory_failure_episodes WHERE dataset_id=%s', (row,)).fetchone() == (1, None)
	ready(db, row)
	assert db.execute('SELECT recovered_at IS NOT NULL FROM public.factory_failure_episodes WHERE dataset_id=%s', (row,)).fetchone()[0]
	# A later regression is a new failure episode but not a new first result.
	db.execute('UPDATE public.v2_statuses SET has_error=true WHERE dataset_id=%s', (row,))
	assert db.execute('SELECT count(*) FROM public.factory_failure_episodes WHERE dataset_id=%s', (row,)).fetchone()[0] == 2


def test_legacy_status_never_gets_invented_upload_time(db):
	owner = user(db)
	row = dataset(db, owner)
	db.execute("UPDATE public.v2_datasets SET created_at='2020-01-01' WHERE id=%s", (row,))
	db.execute('UPDATE public.v2_statuses SET is_upload_done=true WHERE dataset_id=%s', (row,))
	ready(db, row)
	assert db.execute('SELECT * FROM public.factory_submissions WHERE dataset_id=%s', (row,)).fetchall() == []


def test_recipient_dedup_and_matching_bucket_dataset_list(db):
	owner = user(db, operate=True)
	other = user(db)
	row = upload(db, owner)
	stamp = datetime.now(timezone.utc)-timedelta(days=10)
	for recipient, time in [(owner,stamp),(other,stamp+timedelta(days=1))]:
		db.execute("""INSERT INTO public.processing_notification_events
		(queue_task_id,dataset_id,event_type,recipient_user_id,recipient_email,task_types,created_at)
		VALUES (%s,%s,'processing_completed',%s,'test@example.invalid',ARRAY['geotiff','embeddings_v1'],%s)""", (row+1000000,row,recipient,time))
	assert db.execute("SELECT count(*) FROM public.factory_metric_events WHERE dataset_id=%s AND metric='recorded_completed'", (row,)).fetchone()[0] == 1
	authenticate(db, owner)
	result = trends(db, interval='day')
	bucket = next(b for b in result['series'] if b['start'][:10] == stamp.date().isoformat())
	assert bucket['recorded_completed'] >= 1
	import json
	filters = dict(metric='recorded_completed',metric_after=bucket['start'],metric_before=bucket['end'],archived='all',ids=[row])
	assert db.execute('SELECT public.factory_datasets(%s)', (json.dumps(filters),)).fetchone()[0]['total'] == 1
	filters['metric_after'] = (stamp+timedelta(hours=1)).isoformat()
	assert db.execute('SELECT public.factory_datasets(%s)', (json.dumps(filters),)).fetchone()[0]['total'] == 0


def test_unknown_bytes_and_pre_tracking_buckets_remain_unknown(db):
	owner = user(db, operate=True)
	row = upload(db, owner, size=None)
	ready(db, row)
	authenticate(db, owner)
	result = trends(db, size='unknown')
	assert result['summary']['missing_volume'] >= 1
	assert result['summary']['completed_input_gib'] is None
	old = [b for b in result['series'] if not b['measured']]
	assert old and all(b['first_ready'] is None and b['uploaded'] is None for b in old)
	assert result['series'][-1]['partial'] is True


def test_local_durations_pending_and_overdue_population(db):
	owner = user(db, operate=True)
	completed = upload(db, owner, size=1000)
	pending = upload(db, owner, size=1000)
	large = upload(db, owner, size=2*1073741824)
	ready(db, completed)
	# Synthetic clock fixtures are DB-admin-only, never exposed to the UI.
	db.execute("UPDATE public.factory_submissions SET uploaded_at=now()-interval '5 hours' WHERE dataset_id IN (%s,%s,%s)", (completed,pending,large))
	db.execute("UPDATE public.factory_submissions SET first_ready_at=now()-interval '2 hours' WHERE dataset_id=%s", (completed,))
	authenticate(db, owner)
	result = trends(db, size='small')['summary']
	assert result['lead_samples'] >= 1 and result['lead_p90_hours'] >= 3
	assert result['waiting'] >= 1 and result['oldest_wait_hours'] >= 5
	import json
	for row, expected in [(pending,1),(large,0)]:
		assert db.execute('SELECT public.factory_datasets(%s)', (json.dumps(dict(metric='overdue',ids=[row])),)).fetchone()[0]['total'] == expected


@pytest.mark.parametrize('role', ['anon','auditor','operator'])
def test_metrics_permissions_and_no_direct_ledger_writes(db, role):
	owner=user(db,operate=role=='operator',audit=role=='auditor')
	if role=='anon':
		db.execute('SET LOCAL ROLE anon')
	else:
		authenticate(db, owner)
	if role!='operator':
		with pytest.raises(psycopg.errors.InsufficientPrivilege):
			trends(db)
	else:
		assert trends(db)['tracking_since']
		with pytest.raises(psycopg.errors.InsufficientPrivilege):
			db.execute('SELECT * FROM public.factory_submissions')


@pytest.mark.parametrize('kwargs', [dict(interval='month'),dict(workflow='bad'),dict(size='bytes')])
def test_invalid_trend_filters(db, kwargs):
	owner=user(db,operate=True)
	authenticate(db, owner)
	with pytest.raises(psycopg.errors.InvalidParameterValue):
		trends(db,**kwargs)


@pytest.mark.parametrize('timezone_name', ['Pacific/Auckland','Europe/Berlin'])
def test_calendar_buckets_remain_utc_across_session_timezones(db, timezone_name):
	owner=user(db,operate=True)
	db.execute("SELECT set_config('TimeZone',%s,true)",(timezone_name,))
	authenticate(db, owner)
	result=trends(db)
	for bucket in result['series']:
		start=datetime.fromisoformat(bucket['start'])
		end=datetime.fromisoformat(bucket['end'])
		assert start.utcoffset() == timedelta(0) and start.hour == 0
		assert end-start == timedelta(days=7)
