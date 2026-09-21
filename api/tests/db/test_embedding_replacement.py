"""Real processor/auditor RPC contracts for dataset-level embedding replacement."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import psycopg
import pytest
from postgrest.exceptions import APIError

from shared.db import login, use_anon_client, use_client
from shared.settings import settings

VECTOR = '[' + ','.join(['0.03125'] * 1024) + ']'


@pytest.fixture
def replacement(test_user, test_user2):
	assert urlparse(settings.SUPABASE_DB_URL).hostname in {'localhost', '127.0.0.1', 'host.docker.internal'}
	with psycopg.connect(settings.SUPABASE_DB_URL, autocommit=True) as db:
		dataset = db.execute(
			'INSERT INTO public.v2_datasets(user_id,file_name,license,platform,data_access) '
			"VALUES(%s,'embedding-replacement.tif','CC BY','drone','public') RETURNING id",
			(test_user2,),
		).fetchone()[0]
		db.execute(
			'INSERT INTO public.v2_statuses(dataset_id,is_cog_done,is_aoi_done) VALUES(%s,true,true)', (dataset,)
		)
		claim_time = datetime.now(timezone.utc)
		task = db.execute(
			'INSERT INTO public.v2_queue(dataset_id,user_id,task_types,is_processing,claimed_by,claimed_at,priority) '
			"VALUES(%s,%s,ARRAY['geotiff','embeddings_v1']::text[],true,'embedding-test',%s,2) RETURNING id",
			(dataset, test_user2, claim_time),
		).fetchone()[0]
		old_privilege = db.execute(
			'SELECT can_audit,can_view_all_private FROM public.privileged_users WHERE user_id=%s', (test_user,)
		).fetchone()
		db.execute(
			'INSERT INTO public.privileged_users(user_id,can_audit,can_view_all_private) VALUES(%s,true,false) ON CONFLICT(user_id) DO UPDATE SET can_audit=true,can_view_all_private=false',
			(test_user,),
		)
		try:
			yield {
				'db': db,
				'dataset': dataset,
				'task': task,
				'claim': {'p_task_id': task, 'p_claimed_at': claim_time.isoformat()},
				'processor': login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False),
				'auditor': login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False),
				'user': login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False),
				'auditor_id': test_user,
			}
		finally:
			db.execute('DELETE FROM public.v2_datasets WHERE id=%s', (dataset,))
			if old_privilege:
				db.execute(
					'UPDATE public.privileged_users SET can_audit=%s,can_view_all_private=%s WHERE user_id=%s',
					(*old_privilege, test_user),
				)
			else:
				db.execute('DELETE FROM public.privileged_users WHERE user_id=%s', (test_user,))


def rpc(context, name, **params):
	with use_client(context['processor']) as client:
		return client.rpc(name, {**context['claim'], **params}).execute().data


def tile(x=0):
	return {
		'min_lon': 8 + x * 0.001,
		'min_lat': 48,
		'max_lon': 8.001 + x * 0.001,
		'max_lat': 48.001,
		'embedding': VECTOR,
		'pixel_x0': x * 512,
		'pixel_y0': 0,
		'pixel_x1': (x + 1) * 512,
		'pixel_y1': 512,
		'nodata_fraction': 0,
		'bg_sims': [0.0],
	}


def search(context, token=None):
	with use_client(token or context['auditor']) as client:
		return (
			client.rpc('search_tiles_by_embedding', {'query_embedding': VECTOR, 'p_dataset_id': context['dataset']})
			.execute()
			.data
		)


def search_anonymous(context):
	with use_anon_client() as client:
		return (
			client.rpc('search_tiles_by_embedding', {'query_embedding': VECTOR, 'p_dataset_id': context['dataset']})
			.execute()
			.data
		)


def count(context):
	return (
		context['db']
		.execute('SELECT count(*) FROM public.v2_tile_embeddings WHERE dataset_id=%s', (context['dataset'],))
		.fetchone()[0]
	)


def new_claim(context):
	stamp = datetime.fromisoformat(context['claim']['p_claimed_at']) + timedelta(seconds=1)
	context['db'].execute('UPDATE public.v2_queue SET claimed_at=%s WHERE id=%s', (stamp, context['task']))
	context['db'].execute(
		"UPDATE public.v2_statuses SET current_status='idle',has_error=false WHERE dataset_id=%s", (context['dataset'],)
	)
	context['claim'] = {'p_task_id': context['task'], 'p_claimed_at': stamp.isoformat()}


def test_partial_failure_retry_and_complete_rerun(replacement):
	r = replacement
	rpc(r, 'begin_tile_embeddings')
	rpc(r, 'insert_tile_embeddings', p_offset=0, p_rows=[tile()])
	assert search(r) == []
	# A bad second chunk rolls back only that request; incomplete rows stay hidden.
	with pytest.raises(APIError):
		rpc(r, 'insert_tile_embeddings', p_offset=1, p_rows=[{**tile(1), 'embedding': 'invalid'}])
	assert count(r) == 1
	assert search(r) == []
	new_claim(r)
	rpc(r, 'begin_tile_embeddings')
	assert count(r) == 0
	rpc(r, 'insert_tile_embeddings', p_offset=0, p_rows=[tile(), tile(1)])
	with pytest.raises(APIError, match='stored 2 tile embeddings, expected 3'):
		rpc(r, 'complete_tile_embeddings', p_expected_count=3)
	assert search(r) == []
	assert rpc(r, 'complete_tile_embeddings', p_expected_count=2) == 2
	assert len(search(r)) == 2
	with use_client(r['auditor']) as client:
		results = (
			client.rpc('search_datasets_by_embedding', {'query_embedding': VECTOR, 'min_similarity': 0}).execute().data
		)
	assert r['dataset'] in [row['dataset_id'] for row in results]
	# Previously complete datasets disappear during replacement as agreed.
	new_claim(r)
	rpc(r, 'begin_tile_embeddings')
	assert search(r) == [] and count(r) == 0
	rpc(r, 'insert_tile_embeddings', p_offset=0, p_rows=[tile(2)])
	assert rpc(r, 'complete_tile_embeddings', p_expected_count=1) == 1
	assert count(r) == 1 and len(search(r)) == 1
	assert r['db'].execute(
		'SELECT is_cog_done,is_aoi_done FROM public.v2_statuses WHERE dataset_id=%s', (r['dataset'],)
	).fetchone() == (True, True)


def test_concurrent_begin_chunks_and_stale_attempt(replacement):
	r = replacement

	def attempt(name, **params):
		try:
			rpc(r, name, **params)
			return 'ok'
		except APIError:
			return 'rejected'

	with ThreadPoolExecutor(max_workers=2) as pool:
		assert sorted(pool.map(lambda _: attempt('begin_tile_embeddings'), range(2))) == ['ok', 'rejected']
	with ThreadPoolExecutor(max_workers=2) as pool:
		assert sorted(pool.map(lambda _: attempt('insert_tile_embeddings', p_offset=0, p_rows=[tile()]), range(2))) == [
			'ok',
			'rejected',
		]
	assert count(r) == 1
	stale = {**r, 'claim': r['claim'].copy()}
	new_claim(r)
	rpc(r, 'begin_tile_embeddings')
	for name, params in [
		('begin_tile_embeddings', {}),
		('insert_tile_embeddings', {'p_offset': 0, 'p_rows': [tile()]}),
		('complete_tile_embeddings', {'p_expected_count': 0}),
	]:
		with pytest.raises(APIError, match='claim is no longer current'):
			rpc(stale, name, **params)
	assert count(r) == 0 and search(r) == []
	assert rpc(r, 'complete_tile_embeddings', p_expected_count=0) == 0
	with pytest.raises(APIError, match='not in progress'):
		rpc(r, 'insert_tile_embeddings', p_offset=0, p_rows=[tile()])


def test_authorization_visibility_and_aoi(replacement):
	r = replacement
	with use_client(r['user']) as client:
		for name, params in [
			('begin_tile_embeddings', {}),
			('insert_tile_embeddings', {'p_offset': 0, 'p_rows': [tile()]}),
			('complete_tile_embeddings', {'p_expected_count': 0}),
		]:
			with pytest.raises(APIError, match='not authorized'):
				client.rpc(name, {**r['claim'], **params}).execute()
		with pytest.raises(APIError):
			client.table('v2_tile_embeddings').delete().eq('dataset_id', r['dataset']).execute()
	# Search is public, but nothing is published before validated completion.
	assert search(r, r['user']) == [] and search_anonymous(r) == []
	rpc(r, 'begin_tile_embeddings')
	rpc(r, 'insert_tile_embeddings', p_offset=0, p_rows=[tile(), tile(20)])
	# AOI covers only the first tile. Finish must compute membership after insertion.
	r['db'].execute(
		'INSERT INTO public.v2_aois(dataset_id,user_id,geometry) VALUES(%s,%s,ST_AsGeoJSON(ST_MakeEnvelope(7.999,47.999,8.002,48.002,4326))::jsonb)',
		(r['dataset'], r['auditor_id']),
	)
	assert rpc(r, 'complete_tile_embeddings', p_expected_count=2) == 2
	assert len(search(r)) == 1
	assert len(search_anonymous(r)) == 1
	r['db'].execute("UPDATE public.v2_datasets SET data_access='private' WHERE id=%s", (r['dataset'],))
	assert search(r) == []
	# Public callers never see private datasets; the owner still does.
	assert search_anonymous(r) == []
	assert len(search(r, r['user'])) == 1
	r['db'].execute('UPDATE public.privileged_users SET can_view_all_private=true WHERE user_id=%s', (r['auditor_id'],))
	assert len(search(r)) == 1
	r['db'].execute('UPDATE public.v2_datasets SET archived=true WHERE id=%s', (r['dataset'],))
	assert search(r) == []


def test_legacy_worker_cannot_insert_or_publish(replacement):
	r = replacement
	with use_client(r['processor']) as client:
		with pytest.raises(APIError, match='Could not find the function'):
			client.rpc('insert_tile_embeddings', {'p_dataset_id': r['dataset'], 'p_rows': [tile()]}).execute()
		with pytest.raises(APIError, match='Could not find the function'):
			client.rpc(
				'activate_tile_embeddings',
				{'p_dataset_id': r['dataset'], 'p_old_max_id': None, 'p_expected_count': 1},
			).execute()
	assert count(r) == 0 and search(r) == []


def test_status_write_cannot_bypass_completion(replacement):
	r = replacement
	rpc(r, 'begin_tile_embeddings')
	rpc(r, 'insert_tile_embeddings', p_offset=0, p_rows=[tile()])
	# Status rows are not unique per dataset and authenticated users can insert
	# them. A second row must not provide a shortcut around validated completion.
	with use_client(r['user']) as client:
		with pytest.raises(APIError, match='embedding completion requires'):
			client.table('v2_statuses').insert({'dataset_id': r['dataset'], 'is_embeddings_done': True}).execute()
	for token in (r['processor'], r['auditor']):
		with use_client(token) as client:
			with pytest.raises(APIError, match='embedding completion requires'):
				client.table('v2_statuses').update({'is_embeddings_done': True}).eq('dataset_id', r['dataset']).execute()
	assert search(r) == []
	assert rpc(r, 'complete_tile_embeddings', p_expected_count=1) == 1
	assert len(search(r)) == 1


def test_completion_never_updates_embedding_rows(replacement):
	r = replacement
	rpc(r, 'begin_tile_embeddings')
	for start in range(0, 1000, 200):
		rpc(r, 'insert_tile_embeddings', p_offset=start, p_rows=[tile(x) for x in range(start, start + 200)])
	# A statement trigger fails even a zero-row UPDATE: detects mass activation
	# returning without relying on machine-specific wall-clock thresholds.
	r['db'].execute(
		"CREATE FUNCTION public.test_forbid_embedding_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'embedding rows must remain immutable'; END $$"
	)
	try:
		r['db'].execute(
			'CREATE TRIGGER test_forbid_embedding_update BEFORE UPDATE ON public.v2_tile_embeddings FOR EACH STATEMENT EXECUTE FUNCTION public.test_forbid_embedding_update()'
		)
		assert rpc(r, 'complete_tile_embeddings', p_expected_count=1000) == 1000
		assert count(r) == 1000
	finally:
		r['db'].execute('DROP TRIGGER test_forbid_embedding_update ON public.v2_tile_embeddings')
		r['db'].execute('DROP FUNCTION public.test_forbid_embedding_update()')


def test_insert_chunk_has_its_own_timeout_budget(replacement):
	r = replacement
	assert r['db'].execute("SELECT rolconfig FROM pg_roles WHERE rolname='authenticated'").fetchone()[0] == [
		'statement_timeout=8s'
	]
	rpc(r, 'begin_tile_embeddings')
	r['db'].execute(
		'CREATE FUNCTION public.test_slow_embedding_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(8.2); RETURN NULL; END $$'
	)
	try:
		r['db'].execute(
			'CREATE TRIGGER test_slow_embedding_insert BEFORE INSERT ON public.v2_tile_embeddings FOR EACH STATEMENT EXECUTE FUNCTION public.test_slow_embedding_insert()'
		)
		assert rpc(r, 'insert_tile_embeddings', p_offset=0, p_rows=[tile(i) for i in range(200)]) == 200
		assert rpc(r, 'complete_tile_embeddings', p_expected_count=200) == 200
	finally:
		r['db'].execute('DROP TRIGGER test_slow_embedding_insert ON public.v2_tile_embeddings')
		r['db'].execute('DROP FUNCTION public.test_slow_embedding_insert()')


def test_aoi_failure_cannot_publish_partial_result(replacement):
	r = replacement
	rpc(r, 'begin_tile_embeddings')
	rpc(r, 'insert_tile_embeddings', p_offset=0, p_rows=[tile()])
	r['db'].execute(
		"CREATE FUNCTION public.test_fail_aoi_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'AOI membership unavailable'; END $$"
	)
	try:
		r['db'].execute(
			'CREATE TRIGGER test_fail_aoi_membership BEFORE INSERT ON public.v2_tile_aoi_membership FOR EACH STATEMENT EXECUTE FUNCTION public.test_fail_aoi_membership()'
		)
		with pytest.raises(APIError, match='AOI membership unavailable'):
			rpc(r, 'complete_tile_embeddings', p_expected_count=1)
		assert count(r) == 1 and search(r) == []
		assert r['db'].execute(
			'SELECT is_embeddings_done FROM public.v2_statuses WHERE dataset_id=%s', (r['dataset'],)
		).fetchone() == (False,)
	finally:
		r['db'].execute('DROP TRIGGER test_fail_aoi_membership ON public.v2_tile_aoi_membership')
		r['db'].execute('DROP FUNCTION public.test_fail_aoi_membership()')
	assert rpc(r, 'complete_tile_embeddings', p_expected_count=1) == 1
	assert len(search(r)) == 1


def test_invalid_or_competing_queue_claim_is_rejected(replacement):
	r = replacement
	for types in ([], ['metadata'], [None]):
		r['db'].execute('UPDATE public.v2_queue SET task_types=%s WHERE id=%s', (types, r['task']))
		with pytest.raises(APIError, match='claim is no longer current'):
			rpc(r, 'begin_tile_embeddings')
	r['db'].execute("UPDATE public.v2_queue SET task_types=ARRAY['embeddings_v1'] WHERE id=%s", (r['task'],))
	other = (
		r['db']
		.execute(
			"INSERT INTO public.v2_queue(dataset_id,user_id,task_types,is_processing,claimed_by,claimed_at,priority) SELECT dataset_id,user_id,task_types,true,'other-worker',now(),2 FROM public.v2_queue WHERE id=%s RETURNING id",
			(r['task'],),
		)
		.fetchone()[0]
	)
	with pytest.raises(APIError, match='another task is processing'):
		rpc(r, 'begin_tile_embeddings')
	r['db'].execute('DELETE FROM public.v2_queue WHERE id=%s', (other,))
	rpc(r, 'begin_tile_embeddings')
	assert rpc(r, 'complete_tile_embeddings', p_expected_count=0) == 0
