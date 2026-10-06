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


def test_known_hosts_get_names_states_and_daily_counts(db):
	operator = user(db, operate=True)
	busy, done, failed = dataset(db, operator), dataset(db, operator), dataset(db, operator)
	db.execute(
		"INSERT INTO public.v2_queue(dataset_id,user_id,is_processing,claimed_by,claimed_at) VALUES(%s,%s,true,'host-bb400fd18e59',now())",
		(busy, operator),
	)
	log(db, busy, 'host-bb400fd18e59', 'task_started')
	log(db, done, 'host-f9760a054cb8', 'task_started', hours_ago=3)
	log(db, done, 'host-f9760a054cb8', 'task_completed', hours_ago=2)
	log(db, failed, 'host-f9760a054cb8', 'task_started', hours_ago=30)
	log(db, failed, 'host-f9760a054cb8', 'task_failed', hours_ago=29, stage='cog_processing')
	authenticate(db, operator)

	rows = processors(db)

	helicon = rows['host-bb400fd18e59']
	assert (helicon['name'], helicon['state'], helicon['started_24h']) == ('helicon', 'working', 1)
	assert [c['dataset_id'] for c in helicon['claims']] == [busy]
	server = rows['host-f9760a054cb8']
	assert (server['name'], server['state']) == ('processing-server', 'idle')
	assert (server['started_24h'], server['completed_24h'], server['failed_24h']) == (1, 1, 0)
	assert server['last_failure']['dataset_id'] == failed
	assert server['last_failure']['stage'] == 'cog_processing'
	assert rows['host-56916e6e7ab8']['name'] == 'deepl1'


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
