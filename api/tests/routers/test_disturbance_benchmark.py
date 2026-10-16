import shutil

import pytest
import requests
from fastapi.testclient import TestClient

from api.src.access.tickets import sign_ticket
from api.src.server import app
from shared.db import use_service_client
from shared.settings import settings

client = TestClient(app)
CATALOG = b'{"sites": []}'
IMAGE = bytes(range(256)) * 64


def _bearer(account: dict) -> dict:
	return {'Authorization': f"Bearer {account['token']}"}


def _set_core_team(account: dict, member: bool) -> None:
	with use_service_client() as db:
		db.table('privileged_users').delete().eq('user_id', account['id']).execute()
		if member:
			db.table('privileged_users').insert({'user_id': account['id'], 'can_audit': True}).execute()


@pytest.fixture
def benchmark_export():
	root = settings.base_path / settings.DISTURBANCE_BENCHMARK_DIR
	(root / 'Fire_Peru_2024').mkdir(parents=True, exist_ok=True)
	(root / 'catalog.json').write_bytes(CATALOG)
	(root / 'Fire_Peru_2024' / 'drone.webp').write_bytes(IMAGE)
	(settings.base_path / 'releases' / 'outside.json').write_bytes(b'{}')
	yield root
	shutil.rmtree(settings.base_path / 'releases', ignore_errors=True)


@pytest.fixture
def core_member(access_accounts):
	member = access_accounts['admin']
	_set_core_team(member, True)
	yield member
	_set_core_team(member, False)


def _files_url(account: dict) -> str:
	response = client.post('/api/v1/disturbance-benchmark/access', headers=_bearer(account))
	assert response.status_code == 200
	return response.json()['files_url']


def test_access_is_limited_to_the_core_team(access_accounts, core_member):
	assert client.post('/api/v1/disturbance-benchmark/access').status_code == 401
	stranger = client.post('/api/v1/disturbance-benchmark/access', headers=_bearer(access_accounts['stranger']))
	assert stranger.status_code == 403
	assert _files_url(core_member).startswith('/disturbance-benchmark/files/')


def test_signed_files_are_cacheable_and_follow_membership(benchmark_export, core_member):
	files_url = _files_url(core_member)

	catalog = requests.get(f'http://nginx/api/v1{files_url}/catalog.json', timeout=10)
	assert catalog.status_code == 200 and catalog.content == CATALOG
	image = requests.get(f'http://nginx/api/v1{files_url}/Fire_Peru_2024/drone.webp', timeout=10)
	assert image.status_code == 200 and image.content == IMAGE
	assert image.headers['cache-control'] == 'private, max-age=3600'
	assert image.headers['access-control-allow-origin'] == '*'

	_set_core_team(core_member, False)
	assert client.get(f'/api/v1{files_url}/catalog.json').status_code == 404


@pytest.mark.parametrize('case', ['tampered', 'expired', 'other_resource', 'escape', 'directory', 'missing'])
def test_invalid_requests_look_like_missing_files(benchmark_export, core_member, monkeypatch, case):
	if case == 'expired':
		monkeypatch.setattr(settings, 'ASSET_TICKET_TTL_SECONDS', -1)
	ticket, _ = sign_ticket(core_member['id'], 'cog:1' if case == 'other_resource' else 'disturbance-benchmark')
	if case == 'tampered':
		ticket = ticket[:-1] + ('0' if ticket[-1] != '0' else '1')
	relative = {'escape': '%2E%2E%2Foutside.json', 'directory': 'Fire_Peru_2024', 'missing': 'nope.json'}.get(
		case, 'catalog.json'
	)
	response = client.get(f'/api/v1/disturbance-benchmark/files/{ticket}/{relative}')
	assert response.status_code == 404
	assert response.json() == {'detail': 'Not found'}


def test_benchmark_files_are_never_statically_reachable(benchmark_export):
	for path in [
		'/_protected_cacheable/releases/disturbance-benchmark/current/catalog.json',
		'/_protected_data/releases/disturbance-benchmark/current/catalog.json',
		'/assets/v1/../releases/disturbance-benchmark/current/catalog.json',
	]:
		assert requests.get('http://nginx' + path, timeout=10).status_code in (403, 404), path
