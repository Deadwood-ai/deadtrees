"""Exercise the processor's upload/publication protocol at the HTTP boundary."""

import json

import httpx
import pytest
from shapely.geometry import MultiPolygon, box

from processor.src.utils.prediction_labels import create_versioned_model_prediction_label
from shared.models import LabelDataEnum

pytestmark = pytest.mark.unit


@pytest.mark.parametrize('lost_publication_response', [False, True])
def test_upload_inactive_then_publish(monkeypatch, lost_publication_response):
	monkeypatch.setattr('shared.db.cached_session', None)
	monkeypatch.setattr('shared.retry.time.sleep', lambda _delay: None)
	requests = []
	created = None
	publication_attempts = 0
	config = {'module': 'combined', 'checkpoint_name': 'combined.safetensors'}

	def send(client, request, **kwargs):
		nonlocal created, publication_attempts
		path = request.url.path.rsplit('/', 1)[-1]
		data = json.loads(request.content) if request.content else None
		requests.append((request.method, path, data))
		if path == 'token':
			return httpx.Response(
				200,
				request=request,
				json={
					'access_token': 'unit-token',
					'refresh_token': 'unit-refresh',
					'token_type': 'bearer',
					'expires_in': 3600,
					'user': {
						'id': '00000000-0000-0000-0000-000000000001',
						'aud': 'authenticated',
						'created_at': '2026-01-01T00:00:00Z',
						'app_metadata': {},
						'user_metadata': {},
					},
				},
			)
		if path == 'v2_labels' and request.method == 'POST':
			assert data['is_active'] is False and data['version'] == 0
			created = {'id': 99, **data}
			return httpx.Response(201, request=request, json=[created])
		if path == 'v2_forest_cover_geometries':
			if request.method == 'HEAD':
				return httpx.Response(200, request=request, headers={'Content-Range': '*/0'})
			assert request.method == 'POST'
			assert len(data) == 2 and all(isinstance(row['geometry'], str) for row in data)
			assert 'return=minimal' in request.headers['prefer']
			return httpx.Response(201, request=request)
		if path == 'publish_model_prediction_label':
			assert data == {'p_label_id': 99, 'p_expected_geometry_count': 2}
			publication_attempts += 1
			if lost_publication_response and publication_attempts == 1:
				raise httpx.ReadError('Server disconnected without sending a response.')
			return httpx.Response(
				200, request=request, json={**created, 'is_active': True, 'version': 3, 'parent_label_id': 10}
			)
		if path == 'v2_logs':
			return httpx.Response(201, request=request, json=[])
		raise AssertionError(f'Unexpected request: {request.method} {path}')

	monkeypatch.setattr(httpx.Client, 'send', send)
	label = create_versioned_model_prediction_label(
		123,
		'00000000-0000-0000-0000-000000000002',
		LabelDataEnum.forest_cover,
		MultiPolygon([box(7, 48, 7.001, 48.001), box(7.002, 48, 7.003, 48.001)]).__geo_interface__,
		'expired-token',
		config,
	)
	assert label.id == 99 and label.version == 3 and label.parent_label_id == 10 and label.is_active
	assert publication_attempts == (2 if lost_publication_response else 1)
	assert sum(method == 'POST' and path == 'v2_labels' for method, path, _ in requests) == 1
	assert sum(method == 'POST' and path == 'v2_forest_cover_geometries' for method, path, _ in requests) == 1
	assert not any(method == 'PATCH' for method, _, _ in requests)
