"""Exercise atomic embedding publication through the real local PostgREST RPC."""

import json
from urllib.parse import urlparse

import psycopg
import pytest
from postgrest.exceptions import APIError

from shared.db import login, use_client
from shared.settings import settings


@pytest.fixture
def embedding_dataset(test_user):
	# This fixture commits rows for PostgREST to see. Never use a remote database.
	assert urlparse(settings.SUPABASE_DB_URL).hostname in {'127.0.0.1', 'localhost', 'host.docker.internal'}
	with psycopg.connect(settings.SUPABASE_DB_URL, autocommit=True) as db:
		dataset_id = db.execute(
			'INSERT INTO public.v2_datasets (user_id,file_name,license,platform,data_access) '
			"VALUES (%s,'embedding-activation.tif','CC BY','drone','private') RETURNING id",
			(test_user,),
		).fetchone()[0]
		try:
			yield db, dataset_id
		finally:
			db.execute('DELETE FROM public.v2_datasets WHERE id=%s', (dataset_id,))


def insert_tile(db, dataset_id, *, active=False, outside=False):
	longitude = 9 if outside else 8
	return db.execute(
		'INSERT INTO public.v2_tile_embeddings '
		'(dataset_id,geometry,embedding,pixel_x0,pixel_y0,pixel_x1,pixel_y1,is_active) '
		'VALUES (%s,ST_MakeEnvelope(%s,48,%s,48.001,4326),%s::vector,0,0,512,512,%s) RETURNING id',
		(dataset_id, longitude, longitude + 0.001, '[' + ','.join(['0.03125'] * 1024) + ']', active),
	).fetchone()[0]


def activate(dataset_id, old_max_id, count, token):
	with use_client(token) as client:
		return (
			client.rpc(
				'activate_tile_embeddings',
				{'p_dataset_id': dataset_id, 'p_old_max_id': old_max_id, 'p_expected_count': count},
			)
			.execute()
			.data
		)


def test_activation_can_exceed_ordinary_rpc_timeout(embedding_dataset):
	"""A slow indexed update must finish without widening the ordinary RPC budget.

	Delay one fixture row so the regression is deterministic across database sizes
	and machines. The real RPC still performs activation and membership publication.
	"""
	db, dataset_id = embedding_dataset
	insert_tile(db, dataset_id)
	role_settings = db.execute("SELECT rolconfig FROM pg_roles WHERE rolname='authenticated'").fetchone()[0]
	assert 'statement_timeout=8s' in role_settings
	db.execute(
		f"""CREATE FUNCTION public.test_slow_embedding_activation() RETURNS trigger
		LANGUAGE plpgsql AS $$ BEGIN
		  IF NEW.dataset_id = {dataset_id} THEN PERFORM pg_sleep(8.2); END IF;
		  RETURN NEW;
		END $$"""
	)
	try:
		db.execute(
			'CREATE TRIGGER test_slow_embedding_activation BEFORE UPDATE OF is_active '
			'ON public.v2_tile_embeddings FOR EACH ROW '
			'EXECUTE FUNCTION public.test_slow_embedding_activation()'
		)
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)
		assert activate(dataset_id, None, 1, token) == 1
		assert db.execute(
			'SELECT e.is_active,m.in_aoi FROM public.v2_tile_embeddings e '
			'JOIN public.v2_tile_aoi_membership m ON m.tile_id=e.id WHERE e.dataset_id=%s',
			(dataset_id,),
		).fetchall() == [(True, True)]
		assert db.execute("SELECT rolconfig FROM pg_roles WHERE rolname='authenticated'").fetchone()[0] == role_settings
	finally:
		db.execute('DROP TRIGGER IF EXISTS test_slow_embedding_activation ON public.v2_tile_embeddings')
		db.execute('DROP FUNCTION public.test_slow_embedding_activation()')


def test_activation_keeps_previous_generation_on_count_mismatch(embedding_dataset):
	db, dataset_id = embedding_dataset
	old_id = insert_tile(db, dataset_id, active=True)
	new_id = insert_tile(db, dataset_id)
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)
	with pytest.raises(APIError, match='expected 2'):
		activate(dataset_id, old_id, 2, token)
	assert db.execute(
		'SELECT id,is_active FROM public.v2_tile_embeddings WHERE dataset_id=%s ORDER BY id',
		(dataset_id,),
	).fetchall() == [(old_id, True), (new_id, False)]
	assert activate(dataset_id, old_id, 1, token) == 1
	assert db.execute(
		'SELECT id,is_active FROM public.v2_tile_embeddings WHERE dataset_id=%s', (dataset_id,)
	).fetchall() == [(new_id, True)]
	# An empty replacement is valid and removes the previous generation atomically.
	assert activate(dataset_id, new_id, 0, token) == 0
	assert (
		db.execute('SELECT count(*) FROM public.v2_tile_embeddings WHERE dataset_id=%s', (dataset_id,)).fetchone()[0]
		== 0
	)


def test_activation_preserves_aoi_filter_and_processor_authorization(embedding_dataset, test_user):
	db, dataset_id = embedding_dataset
	aoi = {
		'type': 'Polygon',
		'coordinates': [[[7.99, 47.99], [8.01, 47.99], [8.01, 48.01], [7.99, 48.01], [7.99, 47.99]]],
	}
	db.execute(
		'INSERT INTO public.v2_aois(dataset_id,user_id,geometry) VALUES(%s,%s,%s::jsonb)',
		(dataset_id, test_user, json.dumps(aoi)),
	)
	inside_id = insert_tile(db, dataset_id)
	outside_id = insert_tile(db, dataset_id, outside=True)
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)
	with pytest.raises(APIError, match='not authorized'):
		activate(dataset_id, None, 2, user_token)
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)
	assert activate(dataset_id, None, 2, token) == 2
	assert db.execute(
		'SELECT tile_id,in_aoi FROM public.v2_tile_aoi_membership WHERE dataset_id=%s ORDER BY tile_id',
		(dataset_id,),
	).fetchall() == [(inside_id, True), (outside_id, False)]
