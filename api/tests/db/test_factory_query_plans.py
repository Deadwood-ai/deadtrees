"""Planner and pagination regressions for Factory reads; no wall-clock assertions."""
import json

from api.tests.db.test_factory import authenticate, dataset, db, user  # noqa: F401


def walk_plan(node):
	yield node
	for child in node.get('Plans', []):
		yield from walk_plan(child)


def test_filters_inline_instead_of_hydrating_every_dataset(db):
	# A function SET clause is an optimization fence even if its SQL is unchanged.
	plan = db.execute(
		"EXPLAIN (FORMAT JSON) SELECT dataset_id FROM public.factory_filtered_datasets('{}')"
	).fetchone()[0][0]['Plan']
	assert not any(n['Node Type'] == 'Function Scan' for n in walk_plan(plan))
	assert 'factory_metric_matches' not in json.dumps(plan)
	assert not any(n.get('Relation Name') == 'v2_logs' for n in walk_plan(plan))
	config = db.execute(
		"SELECT proconfig FROM pg_proc WHERE oid='public.factory_status_ready(public.v2_statuses,text)'::regprocedure"
	).fetchone()[0]
	assert config is None


def test_activity_pages_remain_exact_across_sources_and_timestamp_ties(db):
	owner = user(db, operate=True)
	ids = [dataset(db, owner) for _ in range(7)]
	# Make this transaction's events newest, and deliberately tie all timestamps.
	for row in ids:
		db.execute("UPDATE public.v2_datasets SET created_at=now()+interval '1 day' WHERE id=%s", (row,))
		db.execute(
			"INSERT INTO public.v2_logs(id,dataset_id,created_at,level,message) VALUES(%s,%s,now()+interval '1 day','INFO','page test')",
			(-row, row),
		)
	authenticate(db, owner)
	whole = db.execute("SELECT public.factory_activity('all',30,0)").fetchone()[0]
	first = db.execute("SELECT public.factory_activity('all',5,0)").fetchone()[0]
	second = db.execute("SELECT public.factory_activity('all',5,5)").fetchone()[0]
	assert first['total'] == second['total'] == whole['total']
	assert first['items'] + second['items'] == whole['items'][:10]
	assert [r['kind'] for r in whole['items'][:14]] == ['processing'] * 7 + ['uploads'] * 7
	processing = db.execute("SELECT public.factory_activity('processing',5,2)").fetchone()[0]
	assert processing['items'] == whole['items'][2:7]


def test_filtered_totals_and_page_hydration_preserve_selected_ids(db):
	owner = user(db, operate=True)
	ids = [dataset(db, owner) for _ in range(4)]
	authenticate(db, owner)
	filters = json.dumps({'ids': ids, 'archived': 'all'})
	page = db.execute('SELECT public.factory_datasets(%s,2,1)', (filters,)).fetchone()[0]
	assert page['total'] == 4
	assert [r['dataset_id'] for r in page['items']] == sorted(ids, reverse=True)[1:3]
	assert all(r['file_name'] == 'factory-test.tif' for r in page['items'])


def test_large_detail_histories_are_bounded_and_totals_are_explicit(db):
	owner = user(db, operate=True)
	row = dataset(db, owner)
	db.execute(
		"""INSERT INTO public.processing_notification_events
		(queue_task_id,dataset_id,event_type,recipient_user_id,recipient_email,status,created_at)
		SELECT %s*1000+i,%s,'processing_completed',%s,'synthetic@example.invalid','sent',now()+i*interval '1 second'
		FROM generate_series(1,205)i""",
		(row, row, owner),
	)
	db.execute(
		"""INSERT INTO public.dataset_flags(dataset_id,created_by,description,created_at)
		SELECT %s,%s,'Synthetic performance test',now()+i*interval '1 second'
		FROM generate_series(1,205)i""",
		(row, owner),
	)
	authenticate(db, owner)
	detail = db.execute('SELECT public.factory_dataset(%s)', (row,)).fetchone()[0]
	for section in ('notifications', 'reports'):
		assert detail['record_totals'][section] == 205
		assert len(detail[section]) == 200
		times = [record['created_at'] for record in detail[section]]
		assert times == sorted(times, reverse=True)
