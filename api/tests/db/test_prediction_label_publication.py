"""Prediction uploads through real PostgREST/PostGIS, including interrupted requests."""

from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

import httpx
import psycopg
from psycopg import sql
import pytest
from shapely.geometry import MultiPolygon, Polygon, box

from shared.db import login, use_client
from shared.labels import create_label_with_geometries
from shared.models import LabelPayloadData, TREECOVER_V1_MODEL_CONFIG
from shared.settings import settings


CONFIG = {'module': 'geometry-publication-test', 'checkpoint_name': 'test.safetensors'}


@pytest.fixture
def prediction(test_user, test_user2):
	assert urlparse(settings.SUPABASE_DB_URL).hostname in {'localhost', '127.0.0.1', 'host.docker.internal'}
	with psycopg.connect(settings.SUPABASE_DB_URL, autocommit=True) as db:
		dataset = db.execute(
			'INSERT INTO public.v2_datasets(user_id,file_name,license,platform,data_access) '
			"VALUES(%s,'prediction-publication.tif','CC BY','drone','public') RETURNING id",
			(test_user2,),
		).fetchone()[0]
		try:
			yield {
				'db': db,
				'dataset': dataset,
				'owner': test_user2,
				'other_user': login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False),
				'processor': login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False),
			}
		finally:
			db.execute('DELETE FROM public.v2_geometry_corrections WHERE dataset_id=%s', (dataset,))
			db.execute('DELETE FROM public.v2_datasets WHERE id=%s', (dataset,))


def payload(context, *, config=CONFIG, layer='forest_cover', geometry=None):
	return LabelPayloadData(
		dataset_id=context['dataset'],
		label_source='model_prediction',
		label_type='semantic_segmentation',
		label_data=layer,
		model_metadata=config,
		geometry=geometry or MultiPolygon([box(7.8, 48, 7.801, 48.001)]).__geo_interface__,
	)


def stage(context, **kwargs):
	return create_label_with_geometries(
		payload(context, **kwargs), context['owner'], context['processor'], is_active=False
	)


def publish(context, label_id, count=1, token=None):
	with use_client(token or context['processor']) as client:
		return (
			client.rpc(
				'publish_model_prediction_label',
				{
					'p_label_id': label_id,
					'p_expected_geometry_count': count,
				},
			)
			.execute()
			.data
		)


def state(context):
	return (
		context['db']
		.execute(
			'SELECT id,is_active,version,parent_label_id FROM public.v2_labels WHERE dataset_id=%s ORDER BY id',
			(context['dataset'],),
		)
		.fetchall()
	)


def test_failed_upload_never_publishes_partial_label(prediction, monkeypatch):
	"""Observe visibility after chunk one commits, then interrupt chunk two."""
	old = create_label_with_geometries(
		payload(prediction, config=TREECOVER_V1_MODEL_CONFIG), prediction['owner'], prediction['processor']
	)
	assert (
		prediction['db']
		.execute(
			'SELECT count(*) FROM public.v_export_polygon_candidates WHERE label_id=%s',
			(old.id,),
		)
		.fetchone()[0]
		== 1
	)
	monkeypatch.setattr('shared.labels.MAX_CHUNK_GEOMETRIES', 1)
	original_send = httpx.Client.send
	chunks = 0

	def interrupt(client, request, **kwargs):
		nonlocal chunks
		if request.method == 'POST' and request.url.path.endswith('/v2_forest_cover_geometries'):
			chunks += 1
			if chunks == 2:
				rows = state(prediction)
				assert [row[0] for row in rows if row[1]] == [old.id], 'Incomplete prediction became active'
				with use_client(prediction['other_user']) as reader:
					visible = (
						reader.table(settings.labels_table)
						.select('id')
						.eq('dataset_id', prediction['dataset'])
						.eq('is_active', True)
						.execute()
						.data
					)
				assert [row['id'] for row in visible] == [old.id]
				return httpx.Response(
					400, request=request, json={'code': 'XX000', 'message': 'Injected upload interruption'}
				)
		return original_send(client, request, **kwargs)

	monkeypatch.setattr(httpx.Client, 'send', interrupt)
	geometry = MultiPolygon([box(7.8 + i * 0.002, 48, 7.801 + i * 0.002, 48.001) for i in range(2)])
	with pytest.raises(Exception, match='Injected upload interruption'):
		stage(prediction, geometry=geometry.__geo_interface__, config=TREECOVER_V1_MODEL_CONFIG)
	rows = state(prediction)
	assert [row[0] for row in rows if row[1]] == [old.id]
	assert rows[-1][2] == 0
	assert (
		prediction['db']
		.execute(
			'SELECT count(*) FROM public.v2_forest_cover_geometries WHERE label_id=%s',
			(rows[-1][0],),
		)
		.fetchone()[0]
		== 1
	)
	assert (
		prediction['db']
		.execute(
			'SELECT count(*) FROM public.v_export_polygon_candidates WHERE label_id=%s',
			(rows[-1][0],),
		)
		.fetchone()[0]
		== 0
	)


def test_publication_checks_completeness_and_preserves_other_models(prediction):
	old = stage(prediction, config={**CONFIG, 'training_metadata': {'note': 'preserve matching with extra keys'}})
	assert publish(prediction, old.id)['is_active']
	geometry_id = (
		prediction['db']
		.execute(
			'SELECT id FROM public.v2_forest_cover_geometries WHERE label_id=%s',
			(old.id,),
		)
		.fetchone()[0]
	)
	correction_id = (
		prediction['db']
		.execute(
			'INSERT INTO public.v2_geometry_corrections(geometry_id,layer_type,label_id,dataset_id,operation,user_id,session_id) '
			"VALUES(%s,'forest_cover',%s,%s,'delete',%s,gen_random_uuid()) RETURNING id",
			(geometry_id, old.id, prediction['dataset'], prediction['owner']),
		)
		.fetchone()[0]
	)
	legacy = create_label_with_geometries(
		payload(prediction, config=None), prediction['owner'], prediction['processor']
	)
	other = stage(prediction, config={**CONFIG, 'checkpoint_name': 'other.safetensors'})
	publish(prediction, other.id)
	new = stage(prediction)
	with pytest.raises(Exception, match='geometry count'):
		publish(prediction, new.id, count=2)
	assert {row[0] for row in state(prediction) if row[1]} == {old.id, legacy.id, other.id}
	result = publish(prediction, new.id)
	assert result['version'] == 2 and result['parent_label_id'] == old.id
	assert {row[0] for row in state(prediction) if row[1]} == {new.id, legacy.id, other.id}
	assert publish(prediction, new.id) == result
	# Retrying a successful but superseded publication must never reactivate it.
	assert publish(prediction, old.id)['is_active'] is False
	assert prediction['db'].execute(
		'SELECT label_id,geometry_id FROM public.v2_geometry_corrections WHERE id=%s',
		(correction_id,),
	).fetchone() == (old.id, geometry_id)
	assert (
		prediction['db']
		.execute(
			'SELECT label_id FROM public.v2_forest_cover_geometries WHERE id=%s',
			(geometry_id,),
		)
		.fetchone()[0]
		== old.id
	)


def test_stale_and_concurrent_publication(prediction):
	old = stage(prediction)
	new = stage(prediction)
	publish(prediction, new.id)
	with pytest.raises(Exception, match='newer prediction'):
		publish(prediction, old.id)
	a, b = stage(prediction), stage(prediction)

	def attempt(label):
		try:
			return publish(prediction, label.id)
		except Exception as exc:
			assert 'newer prediction' in str(exc)
			return None

	with ThreadPoolExecutor(max_workers=2) as pool:
		list(pool.map(attempt, [a, b]))
	assert [row[0] for row in state(prediction) if row[1]] == [b.id]


def test_non_owner_cannot_publish_prediction(prediction):
	label = stage(prediction)
	with pytest.raises(Exception):
		publish(prediction, label.id, token=prediction['other_user'])
	assert state(prediction)[0][1] is False


def test_empty_config_cannot_replace_other_models(prediction):
	old = stage(prediction)
	publish(prediction, old.id)
	empty = stage(prediction, config={})
	with pytest.raises(Exception, match='configured model prediction'):
		publish(prediction, empty.id)
	assert [row[0] for row in state(prediction) if row[1]] == [old.id]


@pytest.mark.parametrize('committed', [False, True])
def test_activation_retries_lost_response(prediction, monkeypatch, committed):
	original_send = httpx.Client.send
	patches = 0
	monkeypatch.setattr('shared.retry.time.sleep', lambda _delay: None)

	def interrupt(client, request, **kwargs):
		nonlocal patches
		if request.method == 'PATCH' and request.url.path.endswith('/v2_labels'):
			patches += 1
			if patches == 1:
				if committed:
					assert original_send(client, request, **kwargs).is_success
				raise httpx.ReadError('Server disconnected without sending a response.')
		return original_send(client, request, **kwargs)

	monkeypatch.setattr(httpx.Client, 'send', interrupt)
	label = create_label_with_geometries(payload(prediction), prediction['owner'], prediction['processor'])
	assert patches == 2
	assert state(prediction) == [(label.id, True, 1, None)]


def test_initial_count_timeout_retries_read_before_insert(prediction, monkeypatch):
	original_send = httpx.Client.send
	counts = 0
	monkeypatch.setattr('shared.retry.time.sleep', lambda _delay: None)

	def interrupt(client, request, **kwargs):
		nonlocal counts
		if request.method == 'HEAD' and request.url.path.endswith('/v2_forest_cover_geometries'):
			counts += 1
			if counts == 1:
				return httpx.Response(
					500,
					request=request,
					json={
						'code': '57014',
						'message': 'canceling statement due to statement timeout',
					},
				)
		return original_send(client, request, **kwargs)

	monkeypatch.setattr(httpx.Client, 'send', interrupt)
	label = stage(prediction)
	assert counts == 2
	assert publish(prediction, label.id)['is_active']


@pytest.mark.parametrize('unverifiable', [False, 'network', 'statement_timeout'])
def test_lost_insert_response_never_duplicates_geometries(prediction, monkeypatch, unverifiable):
	original_send = httpx.Client.send
	committed = False
	monkeypatch.setattr('shared.retry.time.sleep', lambda _delay: None)

	def lose_response(client, request, **kwargs):
		nonlocal committed
		if request.url.path.endswith('/v2_forest_cover_geometries'):
			if request.method == 'HEAD' and committed and unverifiable:
				if unverifiable == 'statement_timeout':
					return httpx.Response(
						500,
						request=request,
						json={
							'code': '57014',
							'message': 'canceling statement due to statement timeout',
						},
					)
				raise httpx.ReadError('Server disconnected without sending a response.')
			if request.method == 'POST' and not committed:
				response = original_send(client, request, **kwargs)
				assert response.is_success
				committed = True
				raise httpx.ReadError('Server disconnected without sending a response.')
		return original_send(client, request, **kwargs)

	monkeypatch.setattr(httpx.Client, 'send', lose_response)
	geometry = MultiPolygon([box(7.8 + i * 0.002, 48, 7.801 + i * 0.002, 48.001) for i in range(2)])
	if unverifiable:
		with pytest.raises(Exception, match='Server disconnected|Cannot verify geometry upload count'):
			stage(prediction, geometry=geometry.__geo_interface__)
	else:
		label = stage(prediction, geometry=geometry.__geo_interface__)
		assert publish(prediction, label.id, count=2)['is_active']
	assert (
		prediction['db']
		.execute(
			'SELECT count(*) FROM public.v2_forest_cover_geometries g JOIN public.v2_labels l ON g.label_id=l.id '
			'WHERE l.dataset_id=%s',
			(prediction['dataset'],),
		)
		.fetchone()[0]
		== 2
	)
	assert state(prediction)[0][1] is (not unverifiable)


def test_database_cancelled_batch_splits_without_partial_duplicates(prediction):
	"""A real statement trigger cancels oversized batches; every cancelled insert rolls back."""
	db = prediction['db']
	name = sql.Identifier(f'test_prediction_batch_{prediction["dataset"]}')
	db.execute(
		sql.SQL("""CREATE FUNCTION public.{}() RETURNS trigger LANGUAGE plpgsql AS $fn$
	BEGIN
	  IF (SELECT count(*) FROM inserted g JOIN public.v2_labels l ON l.id=g.label_id WHERE l.dataset_id={}) > 2 THEN
	    RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE='57014';
	  END IF;
	  RETURN NULL;
	END $fn$""").format(name, sql.Literal(prediction['dataset']))
	)
	db.execute(
		sql.SQL(
			'CREATE TRIGGER {} AFTER INSERT ON public.v2_forest_cover_geometries '
			'REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION public.{}()'
		).format(name, name)
	)
	try:
		geometry = MultiPolygon([box(7.8 + i * 0.002, 48, 7.801 + i * 0.002, 48.001) for i in range(7)])
		label = stage(prediction, geometry=geometry.__geo_interface__)
		assert publish(prediction, label.id, count=7)['is_active']
		assert db.execute(
			'SELECT count(*),count(DISTINCT ST_AsBinary(geometry)) FROM public.v2_forest_cover_geometries WHERE label_id=%s',
			(label.id,),
		).fetchone() == (7, 7)
	finally:
		db.execute(sql.SQL('DROP TRIGGER {} ON public.v2_forest_cover_geometries').format(name))
		db.execute(sql.SQL('DROP FUNCTION public.{}()').format(name))


def test_failed_publication_rolls_back_deactivation(prediction):
	old = stage(prediction)
	publish(prediction, old.id)
	new = stage(prediction)
	db = prediction['db']
	name = sql.Identifier(f'test_prediction_publish_{prediction["dataset"]}')
	db.execute(
		sql.SQL("""CREATE FUNCTION public.{}() RETURNS trigger LANGUAGE plpgsql AS $fn$
	BEGIN
	  IF NEW.id={} AND NEW.is_active THEN RAISE EXCEPTION 'Injected publication failure'; END IF;
	  RETURN NEW;
	END $fn$""").format(name, sql.Literal(new.id))
	)
	db.execute(
		sql.SQL(
			'CREATE TRIGGER {} BEFORE UPDATE ON public.v2_labels ' 'FOR EACH ROW EXECUTE FUNCTION public.{}()'
		).format(name, name)
	)
	try:
		with pytest.raises(Exception, match='Injected publication failure'):
			publish(prediction, new.id)
		assert [row[0] for row in state(prediction) if row[1]] == [old.id]
	finally:
		db.execute(sql.SQL('DROP TRIGGER {} ON public.v2_labels').format(name))
		db.execute(sql.SQL('DROP FUNCTION public.{}()').format(name))
	assert publish(prediction, new.id)['is_active']


@pytest.fixture(scope='module')
def oversized_polygon():
	# Connected canopy with many small gaps: >2 MB in WKB, one feature with holes.
	holes = []
	for i in range(30000):
		x, y = 7.8 + (i % 200) * 0.0001, 48 + (i // 200) * 0.0001
		holes.append([(x, y), (x + 0.00004, y), (x + 0.00004, y + 0.00004), (x, y + 0.00004), (x, y)])
	polygon = Polygon(box(7.799, 47.999, 7.822, 48.018).exterior.coords, holes)
	assert polygon.is_valid and len(polygon.wkb) > 2 * 1024 * 1024
	return polygon


@pytest.mark.parametrize('layer', ['deadwood', 'forest_cover'])
def test_oversized_polygon_roundtrip_preserves_feature_and_holes(prediction, oversized_polygon, layer):
	label = stage(prediction, layer=layer, geometry=MultiPolygon([oversized_polygon]).__geo_interface__)
	# Table names come only from this fixed parametrization.
	row = (
		prediction['db']
		.execute(
			f'SELECT count(*), bool_and(ST_IsValid(geometry)), sum(ST_NumInteriorRings(geometry)), '
			f'bool_and(ST_AsBinary(geometry)=%s), sum(area_m2) FROM public.v2_{layer}_geometries WHERE label_id=%s',
			(oversized_polygon.wkb, label.id),
		)
		.fetchone()
	)
	assert row[:4] == (1, True, 30000, True)
	assert row[4] > 0
	assert publish(prediction, label.id)['is_active']
