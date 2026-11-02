import logging
import shutil
import uuid

import pytest
import requests
from fastapi.testclient import TestClient

from api.src.access import privileges
from api.src.access.tickets import redact_file_tickets, sign_ticket
from api.src.routers.audit_images import AUDIT_IMAGE_DIR
from api.src.server import app
from shared.db import use_service_client
from shared.settings import settings

client = TestClient(app)
IMAGE = bytes(range(256)) * 32


def _bearer(account: dict) -> dict:
	return {'Authorization': f"Bearer {account['token']}"}


def _set_auditor(account: dict, member: bool) -> None:
	privileges._core_team.clear()
	with use_service_client() as db:
		db.table('privileged_users').delete().eq('user_id', account['id']).execute()
		if member:
			db.table('privileged_users').insert({'user_id': account['id'], 'can_audit': True}).execute()


@pytest.fixture
def audit_images():
	"""One crop image in its own folder of the audit image directory, and one file beside it."""
	root = settings.base_path / AUDIT_IMAGE_DIR
	created_root = not root.exists()
	folder = f'test-{uuid.uuid4().hex[:8]}'
	(root / folder / 'crop-1').mkdir(parents=True)
	(root / folder / 'crop-1' / 'raw.jpg').write_bytes(IMAGE)
	outside = root.parent / f'{folder}.jpg'
	outside.write_bytes(b'x')
	yield {'folder': folder, 'outside': outside.name}
	shutil.rmtree(root / folder, ignore_errors=True)
	outside.unlink(missing_ok=True)
	if created_root:
		shutil.rmtree(root, ignore_errors=True)


@pytest.fixture
def auditor(access_accounts):
	member = access_accounts['admin']
	_set_auditor(member, True)
	yield member
	_set_auditor(member, False)


def _files_url(account: dict) -> str:
	response = client.post('/api/v1/audit/images/access', headers=_bearer(account))
	assert response.status_code == 200
	return response.json()['files_url']


def test_access_is_limited_to_auditors(access_accounts, auditor):
	assert client.post('/api/v1/audit/images/access').status_code == 401
	stranger = client.post('/api/v1/audit/images/access', headers=_bearer(access_accounts['stranger']))
	assert stranger.status_code == 403
	assert _files_url(auditor).startswith('/audit/images/files/')


def test_signed_images_are_served_and_follow_the_privilege(audit_images, auditor):
	files_url = _files_url(auditor)
	relative = f"{audit_images['folder']}/crop-1/raw.jpg"
	image = requests.get(f'http://nginx/api/v1{files_url}/{relative}', timeout=10)
	assert image.status_code == 200 and image.content == IMAGE
	assert image.headers['cache-control'] == 'private, max-age=3600'

	_set_auditor(auditor, False)
	assert client.get(f'/api/v1{files_url}/{relative}').status_code == 404


@pytest.mark.parametrize('case', ['tampered', 'expired', 'other_resource', 'escape', 'directory', 'missing'])
def test_invalid_requests_look_like_missing_files(audit_images, auditor, monkeypatch, case):
	if case == 'expired':
		monkeypatch.setattr(settings, 'ASSET_TICKET_TTL_SECONDS', -1)
	ticket, _ = sign_ticket(auditor['id'], 'disturbance-benchmark' if case == 'other_resource' else 'audit-images')
	if case == 'tampered':
		ticket = ticket[:-1] + ('0' if ticket[-1] != '0' else '1')
	folder = audit_images['folder']
	relative = {
		'escape': f'%2E%2E%2F{audit_images["outside"]}',
		'directory': f'{folder}/crop-1',
		'missing': f'{folder}/crop-1/nope.jpg',
	}.get(case, f'{folder}/crop-1/raw.jpg')
	response = client.get(f'/api/v1/audit/images/files/{ticket}/{relative}')
	assert response.status_code == 404
	assert response.json() == {'detail': 'Not found'}


def test_audit_images_are_never_statically_reachable(audit_images):
	relative = f"{AUDIT_IMAGE_DIR}/{audit_images['folder']}/crop-1/raw.jpg"
	for path in [f'/_protected_cacheable/{relative}', f'/_protected_data/{relative}', f'/assets/v1/../{relative}']:
		assert requests.get('http://nginx' + path, timeout=10).status_code in (403, 404), path


def test_audit_image_ticket_is_redacted_from_access_log():
	record = logging.LogRecord(
		'uvicorn.access',
		logging.INFO,
		'',
		1,
		'%s - "%s %s HTTP/%s" %d',
		('client', 'GET', '/api/v1/audit/images/files/bearer-secret/12/crop-1/raw.jpg', '1.1', 200),
		None,
	)
	assert redact_file_tickets(record)
	assert 'bearer-secret' not in record.getMessage()
	assert '/audit/images/files/[redacted]/12/crop-1/raw.jpg' in record.getMessage()
