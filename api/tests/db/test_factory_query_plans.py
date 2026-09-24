"""Planner and pagination regressions for Factory reads; no wall-clock assertions."""
import json
import re

from api.tests.db.test_factory import authenticate, dataset, db, user  # noqa: F401


def walk_plan(node):
	yield node
	for child in node.get('Plans', []):
		yield from walk_plan(child)


def production_shaped_logs(db, datasets=20, noise_per_dataset=1000):
	"""Give v2_logs production-like statistics inside the rolled-back test transaction.

	Evidence logs are a few percent of rows, spread over many datasets. Without this,
	statistics left by earlier tests can make a created_at-ordered index look cheaper
	than a dataset-bounded one. Returns one dataset with upload and run evidence."""
	owner = user(db)
	ids = [dataset(db, owner) for _ in range(datasets)]
	db.execute("""INSERT INTO public.v2_logs(dataset_id,created_at,level,category,message)
	SELECT d,now()-make_interval(mins=>i),'INFO','noise','synthetic noise '||i
	FROM unnest(%s::bigint[]) d CROSS JOIN generate_series(1,%s) i""", (ids, noise_per_dataset))
	db.execute("""INSERT INTO public.v2_logs(dataset_id,created_at,level,category,message,extra)
	SELECT d,now()-interval '2 days','INFO','upload','Upload completed successfully for dataset '||d,'{"file_size":1}'::jsonb FROM unnest(%s::bigint[]) d
	UNION ALL SELECT d,now()-interval '1 day','INFO','process','Starting processing for task '||d,'{"task_types":["geotiff"]}'::jsonb FROM unnest(%s::bigint[]) d""", (ids, ids))
	db.execute('ANALYZE public.v2_logs')
	return ids[0]


def assert_logs_read_through(plan, index, row):
	"""Every v2_logs access uses `index` with the dataset bound in its index condition."""
	scans = [n for n in walk_plan(plan) if n.get('Relation Name') == 'v2_logs' or n.get('Index Name') == index]
	bounded = [n for n in scans if n.get('Index Name') == index and re.search(rf"\bdataset_id = '?{row}\b", n.get('Index Cond', ''))]
	heaps = [n for n in scans if n.get('Relation Name') == 'v2_logs' and n['Node Type'] not in ('Index Scan', 'Index Only Scan', 'Bitmap Heap Scan')]
	assert bounded and not heaps, scans
	assert all(n.get('Index Name') in (None, index) for n in scans), scans


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


def test_outcome_evidence_evaluates_the_retained_run_boundary_once(db):
	# A bare STABLE call in the join condition ran once per dataset and timed out
	# factory_north_star at production scale; it must stay a single InitPlan.
	plan = db.execute('EXPLAIN (FORMAT JSON, VERBOSE) SELECT * FROM public.factory_outcome_evidence').fetchone()[0][0]['Plan']
	calls = [n for n in walk_plan(plan) if any('factory_run_evidence_since' in str(v) for k, v in n.items() if k != 'Plans')]
	assert calls and all(n.get('Parent Relationship') == 'InitPlan' for n in calls), calls
