"""Processor health from claims and host-tagged processor logs."""
import json

import psycopg
import pytest
from api.tests.db.test_factory import authenticate, dataset, db, user  # noqa: F401


def log(db, row, worker, event=None, *, hours_ago=0.0, stage=None):
	extra = {'worker_id': worker}
	if event:
		extra['event'] = event
	if stage:
		extra['stage'] = stage
	db.execute(
		"""INSERT INTO public.v2_logs(name,level,message,category,dataset_id,extra,created_at)
		VALUES('processor.src.processor','INFO','test','process',%s,%s,now()-(%s * interval '1 hour'))""",
		(row, json.dumps(extra), hours_ago),
	)


def processors(db):
	result = db.execute('SELECT public.factory_processors()').fetchone()[0]
	return {p['worker_id']: p for p in result['processors']}


def test_known_hosts_are_named(db):
	authenticate(db, user(db, operate=True))
	names = {worker: row['name'] for worker, row in processors(db).items()}
	assert names['host-f9760a054cb8'] == 'processing-server'
	assert names['host-bb400fd18e59'] == 'helicon'
	assert names['host-56916e6e7ab8'] == 'deepl1'


def test_states_and_daily_counts_per_worker(db):
	# Unregistered worker IDs keep the counts independent of other local activity.
	operator = user(db, operate=True)
	busy, done, failed = dataset(db, operator), dataset(db, operator), dataset(db, operator)
	db.execute(
		"INSERT INTO public.v2_queue(dataset_id,user_id,is_processing,claimed_by,claimed_at) VALUES(%s,%s,true,'test-busy',now())",
		(busy, operator),
	)
	log(db, busy, 'test-busy', 'task_started')
	log(db, done, 'test-server', 'task_started', hours_ago=3)
	log(db, done, 'test-server', 'task_completed', hours_ago=2)
	log(db, failed, 'test-server', 'task_started', hours_ago=6)
	log(db, failed, 'test-server', 'task_failed', hours_ago=5, stage='cog_processing')
	log(db, failed, 'test-server', 'task_failed', hours_ago=30, stage='odm_processing')
	authenticate(db, operator)

	rows = processors(db)

	busy_worker = rows['test-busy']
	assert (busy_worker['name'], busy_worker['state'], busy_worker['started_24h']) == ('test-busy', 'working', 1)
	assert [c['dataset_id'] for c in busy_worker['claims']] == [busy]
	server = rows['test-server']
	assert server['state'] == 'idle'
	assert (server['started_24h'], server['completed_24h'], server['failed_24h']) == (2, 1, 1)
	assert server['last_failure']['dataset_id'] == failed
	assert server['last_failure']['stage'] == 'cog_processing'


def test_silent_claims_and_unnamed_workers(db):
	operator = user(db, operate=True)
	row = dataset(db, operator)
	db.execute("UPDATE public.v2_statuses SET updated_at=now()-interval '3 hours' WHERE dataset_id=%s", (row,))
	db.execute(
		"INSERT INTO public.v2_queue(dataset_id,user_id,is_processing,claimed_by,claimed_at) VALUES(%s,%s,true,'host-new123',now()-interval '2 hours')",
		(row, operator),
	)
	authenticate(db, operator)

	new = processors(db)['host-new123']
	assert (new['name'], new['state']) == ('host-new123', 'silent')


def test_processors_require_operator(db):
	authenticate(db, user(db))
	with pytest.raises(psycopg.errors.InsufficientPrivilege), db.transaction():
		db.execute('SELECT public.factory_processors()')


def test_processors_keep_jit_disabled(db):
	config = db.execute("SELECT proconfig FROM pg_proc WHERE oid='public.factory_processors()'::regprocedure").fetchone()[0]
	assert 'jit=off' in config
