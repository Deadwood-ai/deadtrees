"""Historical evidence stays distinct from first-result instrumentation."""
import json
import uuid

import psycopg
import pytest

from api.tests.db.test_factory import authenticate, dataset, db, user  # noqa: F401


def legacy(db, owner):
	row = dataset(db, owner)
	db.execute("UPDATE public.v2_datasets SET created_at='2010-01-01Z',archived=true WHERE id=%s", (row,))
	return row


def log_upload(db, row, stamp='2010-01-02T00:00:00Z', size=1073741824):
	db.execute("""INSERT INTO public.v2_logs(id,dataset_id,created_at,level,category,message,extra)
	VALUES(%s,%s,%s,'INFO','upload',%s,%s)""",
	(uuid.uuid4().int % (2**62),row,stamp,f'Upload completed successfully for dataset {row}',json.dumps({'file_size': size})))


def completed(db, row, owner, stamp='2010-01-03T00:00:00Z', task=None):
	db.execute("""INSERT INTO public.processing_notification_events
	(queue_task_id,dataset_id,event_type,recipient_user_id,recipient_email,task_types,created_at)
	VALUES(%s,%s,'processing_completed',%s,'test@example.invalid',ARRAY['geotiff','embeddings_v1'],%s)""",
	(task or row+1000000,row,owner,stamp))


def history(db, year=2010):
	return db.execute('SELECT public.factory_history(%s)',(year,)).fetchone()[0]


def test_legacy_upload_duplicates_and_drilldown(db):
	owner=user(db,operate=True)
	row=legacy(db,owner)
	log_upload(db,row)
	log_upload(db,row,'2010-01-04Z',999)  # a second upload must not replace first evidence
	completed(db,row,owner)
	completed(db,row,user(db),'2010-01-04Z')  # another recipient, same run
	completed(db,row,owner,'2010-02-03Z',task=row+2000000)  # rerun counts as a run only
	authenticate(db,owner)
	result=history(db)
	jan=result['series'][0]
	assert jan['uploaded']==1 and jan['completed']==1 and jan['indexing']==1
	assert jan['input_gib']==1 and 'p50' not in jan
	assert result['series'][1]['completed']==1
	filters=dict(metric='uploaded',archived='all',metric_after=jan['start'],metric_before=jan['end'],ids=[row])
	assert db.execute('SELECT public.factory_datasets(%s)',(json.dumps(filters),)).fetchone()[0]['total']==1
	detail=db.execute('SELECT public.factory_dataset(%s)',(row,)).fetchone()[0]
	assert detail['status']['historical_upload_source']=='upload_log'
	# A completion notification alone is not a first result; processor run logs are.
	assert detail['status']['first_result_at'] is None
	assert detail['status'].get('first_ready_at') is None


def test_missing_and_invalid_evidence_stays_unknown(db):
	owner=user(db,operate=True)
	row=legacy(db,owner)
	log_upload(db,row,size='invalid')
	authenticate(db,owner)
	jan=history(db)['series'][0]
	assert jan['uploaded']==1 and jan['input_gib'] is None and jan['size_samples']==0


def test_period_before_recording_is_unknown_and_all_history_is_reachable(db):
	owner=user(db,operate=True)
	row=legacy(db,owner)
	log_upload(db,row,'2010-03-01Z')
	completed(db,row,owner,'2010-04-01Z')
	authenticate(db,owner)
	result=history(db)
	assert result['series'][0]['registered']==1
	assert result['series'][0]['uploaded'] is None
	assert result['series'][0]['completed'] is None
	assert result['series'][0]['reports'] is None
	assert result['series'][0]['publications'] is None
	assert result['series'][0]['emails'] is None
	assert result['series'][2]['uploaded']==1 and result['series'][2]['completed'] is None
	all_history=history(db,None)
	assert 2010 in all_history['years']
	assert any(p['start'].startswith('2010') for p in all_history['series'])


def test_prospective_upload_wins_over_log_without_double_count(db):
	owner=user(db,operate=True)
	row=dataset(db,owner,is_upload_done=True,uploaded_input_bytes=2048)
	log_upload(db,row,'2099-01-01Z',9999)  # future logs are not historical evidence
	assert db.execute('SELECT input_bytes,source FROM public.factory_historical_uploads WHERE dataset_id=%s',(row,)).fetchone()==(2048,'measured')


def test_factory_history_permission_and_private_sources(db):
	owner=user(db,audit=True)
	authenticate(db,owner)
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		history(db)


@pytest.mark.parametrize('relation',['factory_historical_uploads','factory_historical_runs'])
def test_history_sources_not_exposed_directly(db,relation):
	authenticate(db,user(db,operate=True))
	with pytest.raises(psycopg.errors.InsufficientPrivilege):
		db.execute(f'SELECT * FROM public.{relation}')


def test_invalid_history_range(db):
	authenticate(db,user(db,operate=True))
	with pytest.raises(psycopg.errors.InvalidParameterValue):
		history(db,1969)


def test_upload_log_reconstruction_has_a_targeted_index(db):
	from api.tests.db.test_factory_query_plans import assert_logs_read_through, production_shaped_logs
	# With production-shaped statistics, a per-dataset read must reach upload
	# evidence through the targeted index bounded by that dataset, never by an
	# unbounded created_at scan. Scale is measured by benchmark-factory.sh.
	row=production_shaped_logs(db)
	db.execute('SET LOCAL enable_seqscan=off')
	plan=db.execute('EXPLAIN (FORMAT JSON) SELECT * FROM public.factory_historical_uploads WHERE dataset_id=%s', (row,)).fetchone()[0][0]['Plan']
	assert_logs_read_through(plan,'factory_upload_success_log_idx',row)


@pytest.mark.parametrize('signature', ['factory_history(integer)','factory_dataset(bigint)','factory_trends(text,text,text)','factory_north_star(boolean)'])
def test_replaced_dashboard_functions_keep_jit_disabled(db,signature):
	config=db.execute("SELECT proconfig FROM pg_proc WHERE oid=%s::regprocedure", ('public.'+signature,)).fetchone()[0]
	assert 'jit=off' in config
