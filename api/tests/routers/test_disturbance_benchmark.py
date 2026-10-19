import shutil
import uuid

import pytest
import requests
from fastapi.testclient import TestClient

from api.src.access import privileges
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
	privileges._core_team.clear()
	with use_service_client() as db:
		db.table('privileged_users').delete().eq('user_id', account['id']).execute()
		if member:
			db.table('privileged_users').insert({'user_id': account['id'], 'can_audit': True}).execute()


@pytest.fixture
def benchmark_export():
	"""Test files in their own folder of the served export, and one file beside the export."""
	root = settings.base_path / settings.DISTURBANCE_BENCHMARK_DIR
	created_root = not root.exists()
	folder = f'test-{uuid.uuid4().hex[:8]}'
	(root / folder / 'Fire_Peru_2024').mkdir(parents=True)
	(root / folder / 'catalog.json').write_bytes(CATALOG)
	(root / folder / 'Fire_Peru_2024' / 'drone.webp').write_bytes(IMAGE)
	outside = root.parent / f'{folder}.json'
	outside.write_bytes(b'{}')
	yield {'folder': folder, 'outside': outside.name}
	shutil.rmtree(root / folder, ignore_errors=True)
	outside.unlink(missing_ok=True)
	if created_root:
		shutil.rmtree(root, ignore_errors=True)


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

	folder = benchmark_export['folder']
	catalog = requests.get(f'http://nginx/api/v1{files_url}/{folder}/catalog.json', timeout=10)
	assert catalog.status_code == 200 and catalog.content == CATALOG
	image = requests.get(f'http://nginx/api/v1{files_url}/{folder}/Fire_Peru_2024/drone.webp', timeout=10)
	assert image.status_code == 200 and image.content == IMAGE
	assert image.headers['cache-control'] == 'private, max-age=3600'
	assert image.headers['access-control-allow-origin'] == '*'

	_set_core_team(core_member, False)
	assert client.get(f'/api/v1{files_url}/{folder}/catalog.json').status_code == 404


@pytest.mark.parametrize('case', ['tampered', 'expired', 'other_resource', 'escape', 'directory', 'missing'])
def test_invalid_requests_look_like_missing_files(benchmark_export, core_member, monkeypatch, case):
	if case == 'expired':
		monkeypatch.setattr(settings, 'ASSET_TICKET_TTL_SECONDS', -1)
	ticket, _ = sign_ticket(core_member['id'], 'cog:1' if case == 'other_resource' else 'disturbance-benchmark')
	if case == 'tampered':
		ticket = ticket[:-1] + ('0' if ticket[-1] != '0' else '1')
	folder = benchmark_export['folder']
	relative = {
		'escape': f'%2E%2E%2F{benchmark_export["outside"]}',
		'directory': f'{folder}/Fire_Peru_2024',
		'missing': f'{folder}/nope.json',
	}.get(case, f'{folder}/catalog.json')
	response = client.get(f'/api/v1/disturbance-benchmark/files/{ticket}/{relative}')
	assert response.status_code == 404
	assert response.json() == {'detail': 'Not found'}


def test_benchmark_files_are_never_statically_reachable(benchmark_export):
	relative = f"{settings.DISTURBANCE_BENCHMARK_DIR}/{benchmark_export['folder']}/catalog.json"
	for path in [f'/_protected_cacheable/{relative}', f'/_protected_data/{relative}', f'/assets/v1/../{relative}']:
		assert requests.get('http://nginx' + path, timeout=10).status_code in (403, 404), path
