import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.src.routers import info

pytestmark = pytest.mark.unit


def test_info_returns_only_name_version_and_docs_without_echoing_headers():
	app = FastAPI(root_path='/api/v1')
	app.include_router(info.router)

	response = TestClient(app).get('/', headers={'Authorization': 'Bearer secret-token', 'Cookie': 'session=abc'})

	assert response.status_code == 200
	body = response.json()
	assert set(body) == {'name', 'version', 'docs'}
	assert body['docs']['swagger'] == '/api/v1/docs'
	assert 'secret-token' not in response.text
	assert 'session=abc' not in response.text
