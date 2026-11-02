import io

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image
from sam_service.app import create_app


class FakeModels:
	def __init__(self):
		self.loaded = False
		self.calls = []

	def load(self):
		self.loaded = True

	def unload(self):
		self.loaded = False

	def segment(self, image, key, box, points, labels):
		self.calls.append(('segment', box, points, labels))
		mask = np.zeros((image.height, image.width), bool)
		mask[4:20, 4:20] = True
		return [mask]

	def find(self, image, text, threshold):
		self.calls.append(('find', text, threshold))
		mask = np.zeros((image.height, image.width), bool)
		mask[2:12, 2:12] = True
		return [mask, mask], [0.9, 0.4]


def _jpeg(size=(32, 32)):
	buffer = io.BytesIO()
	Image.new('RGB', size, (90, 120, 80)).save(buffer, 'JPEG')
	return ('view.jpg', buffer.getvalue(), 'image/jpeg')


def _client():
	models = FakeModels()
	return TestClient(create_app(models)), models


def test_box_and_clicks_reach_the_model_and_return_an_outline():
	client, models = _client()
	response = client.post(
		'/segment',
		files={'image': _jpeg()},
		data={'bboxes': '[1,2,30,31]', 'points': '[[5,6],[7,8]]', 'labels': '[1,0]'},
	)
	assert response.status_code == 200
	assert response.json()['features']
	assert models.loaded
	assert models.calls == [('segment', [1, 2, 30, 31], [[5, 6], [7, 8]], [1, 0])]


def test_clicks_without_matching_labels_count_as_additions():
	client, models = _client()
	client.post('/segment', files={'image': _jpeg()}, data={'points': '[5,6]', 'labels': '[]'})
	assert models.calls == [('segment', None, [[5, 6]], [1])]


def test_concept_search_returns_scored_outlines_and_clamps_the_threshold():
	client, models = _client()
	response = client.post('/concepts', files={'image': _jpeg()}, data={'text': '  tree  ', 'threshold': '5'})
	assert [f['properties']['score'] for f in response.json()['features']] == [0.9, 0.4]
	assert models.calls == [('find', 'tree', 0.95)]


def test_bad_requests_are_refused_before_the_gpu():
	client, models = _client()
	assert client.post('/segment', files={'image': _jpeg()}).status_code == 400
	assert client.post('/segment', files={'image': _jpeg()}, data={'bboxes': '[1,'}).status_code == 400
	assert (
		client.post(
			'/segment', files={'image': ('x.jpg', b'nope', 'image/jpeg')}, data={'bboxes': '[1,1,2,2]'}
		).status_code
		== 400
	)
	assert client.post('/segment', files={'image': _jpeg((2100, 10))}, data={'bboxes': '[1,1,2,2]'}).status_code == 413
	assert client.post('/concepts', files={'image': _jpeg()}, data={'text': '   '}).status_code == 400
	assert models.calls == []


def test_cors_allows_only_the_site():
	client, _ = _client()
	ok = client.options(
		'/segment', headers={'Origin': 'https://deadtrees.earth', 'Access-Control-Request-Method': 'POST'}
	)
	bad = client.options(
		'/segment', headers={'Origin': 'https://evil.example', 'Access-Control-Request-Method': 'POST'}
	)
	assert ok.headers.get('access-control-allow-origin') == 'https://deadtrees.earth'
	assert 'access-control-allow-origin' not in bad.headers
