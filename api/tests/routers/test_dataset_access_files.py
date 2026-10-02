import shutil
import uuid

import pytest
import requests
from fastapi.testclient import TestClient

from api.src.access.tickets import sign_ticket
from api.src.server import app
from shared.db import use_client, use_service_client
from shared.settings import settings

client = TestClient(app)
COG_BYTES = bytes(range(256)) * 512  # 128 KiB with a recognisable byte pattern


def _bearer(account: dict) -> dict:
	return {'Authorization': f"Bearer {account['token']}"}


def _grant(owner: dict, dataset_id: int, grantee: dict, role: str, can_download: bool = False) -> None:
	with use_client(owner['token']) as db:
		db.rpc(
			'set_dataset_access',
			{'p_dataset_id': dataset_id, 'p_email': grantee['email'], 'p_role': role, 'p_can_download': can_download},
		).execute()


@pytest.fixture
def private_dataset_with_cog(access_accounts):
	"""A private dataset whose COG sits in the private tree, as the processor writes it."""
	owner = access_accounts['owner']
	relative_path = f'{uuid.uuid4()}/cog.tif'
	with use_service_client() as db:
		dataset_id = (
			db.table(settings.datasets_table)
			.insert(
				{
					'user_id': owner['id'],
					'file_name': 'private-share.tif',
					'license': 'CC BY',
					'platform': 'drone',
					'authors': ['Access Test Author'],
					'data_access': 'private',
					'aquisition_year': 2025,
					'aquisition_month': 6,
					'aquisition_day': 12,
				}
			)
			.execute()
			.data[0]['id']
		)
		db.table(settings.cogs_table).insert(
			{
				'dataset_id': dataset_id,
				'cog_file_name': 'cog.tif',
				'cog_path': relative_path,
				'cog_file_size': 1,
				'version': 1,
			}
		).execute()
		db.table(settings.statuses_table).insert({'dataset_id': dataset_id, 'current_status': 'idle'}).execute()
	private_file = settings.cog_path / relative_path
	private_file.parent.mkdir(parents=True, exist_ok=True)
	private_file.write_bytes(COG_BYTES)
	yield {'id': dataset_id, 'relative_path': relative_path}
	shutil.rmtree(settings.cog_path / relative_path.split('/')[0], ignore_errors=True)
	with use_service_client() as db:
		db.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def _cog_url(account: dict, dataset_id: int) -> str | None:
	response = client.post(
		'/api/v1/datasets/files/tickets', json={'dataset_ids': [dataset_id]}, headers=_bearer(account)
	)
	assert response.status_code == 200
	files = response.json()['files']
	return files.get(str(dataset_id), {}).get('cog_url')


def test_private_cog_is_never_statically_reachable(private_dataset_with_cog):
	relative = private_dataset_with_cog['relative_path']
	for path in [
		f'/cogs/v1/{relative}',
		f'/cogs/v1/x/../{relative}',
		f'/_protected_data/cogs/{relative}',
		'/cogs/v1/',
		'/downloads/v1/bundles/old.zip',
	]:
		assert requests.get('http://nginx' + path, timeout=10).status_code in (403, 404), path


def test_signed_range_delivery_follows_current_access(access_accounts, private_dataset_with_cog):
	dataset_id = private_dataset_with_cog['id']
	owner, viewer, stranger = access_accounts['owner'], access_accounts['reader'], access_accounts['stranger']

	assert _cog_url(stranger, dataset_id) is None
	assert _cog_url(viewer, dataset_id) is None
	_grant(owner, dataset_id, viewer, 'reader')
	cog_url = _cog_url(viewer, dataset_id)
	assert cog_url == f'/datasets/{dataset_id}/files/cog/' + cog_url.rsplit('/', 1)[1]

	response = requests.get(f'http://nginx/api/v1{cog_url}', headers={'Range': 'bytes=256-511'}, timeout=10)
	assert response.status_code == 206
	assert response.content == COG_BYTES[256:512]
	assert response.headers['content-range'] == f'bytes 256-511/{len(COG_BYTES)}'
	assert response.headers['cache-control'] == 'private, no-store'
	assert response.headers['referrer-policy'] == 'no-referrer'
	head = requests.head(f'http://nginx/api/v1{cog_url}', timeout=10)
	assert head.status_code == 200 and head.content == b''
	assert int(head.headers['content-length']) == len(COG_BYTES)

	# Revocation applies to an address the viewer already holds.
	with use_client(owner['token']) as db:
		db.rpc('revoke_dataset_access', {'p_dataset_id': dataset_id, 'p_user_id': viewer['id']}).execute()
	revoked = client.get(f'/api/v1{cog_url}', headers={'Range': 'bytes=0-15'})
	assert revoked.status_code == 404


@pytest.mark.parametrize('case', ['tampered', 'expired', 'other_kind', 'other_dataset'])
def test_invalid_signed_paths_look_like_missing_files(access_accounts, private_dataset_with_cog, monkeypatch, case):
	dataset_id = private_dataset_with_cog['id']
	owner_id = access_accounts['owner']['id']
	if case == 'expired':
		monkeypatch.setattr(settings, 'ASSET_TICKET_TTL_SECONDS', -1)
	ticket, _ = sign_ticket(owner_id, f'cog:{dataset_id}')
	path = f'/api/v1/datasets/{dataset_id}/files/cog/{ticket}'
	if case == 'tampered':
		path = path[:-1] + ('0' if path[-1] != '0' else '1')
	elif case == 'other_kind':
		path = f'/api/v1/datasets/{dataset_id}/files/thumbnail/{ticket}'
	elif case == 'other_dataset':
		path = f'/api/v1/datasets/{dataset_id + 1}/files/cog/{ticket}'
	response = client.get(path)
	assert response.status_code == 404
	assert response.json() == {'detail': 'Not found'}


def test_visibility_change_preserves_files_during_processing_and_is_owner_only(
	access_accounts, private_dataset_with_cog
):
	dataset_id = private_dataset_with_cog['id']
	relative_path = private_dataset_with_cog['relative_path']
	owner, viewer, stranger = access_accounts['owner'], access_accounts['admin'], access_accounts['stranger']
	_grant(owner, dataset_id, viewer, 'admin')

	hidden = client.put(
		f'/api/v1/datasets/{dataset_id}/visibility', json={'data_access': 'public'}, headers=_bearer(stranger)
	)
	assert hidden.status_code == 404
	not_owner = client.put(
		f'/api/v1/datasets/{dataset_id}/visibility', json={'data_access': 'public'}, headers=_bearer(viewer)
	)
	assert not_owner.status_code == 403

	with use_service_client() as db:
		db.table(settings.queue_table).insert(
			{'dataset_id': dataset_id, 'user_id': owner['id'], 'priority': 2}
		).execute()
	busy = client.put(
		f'/api/v1/datasets/{dataset_id}/visibility', json={'data_access': 'private'}, headers=_bearer(owner)
	)
	assert busy.status_code == 200
	with use_service_client() as db:
		db.table(settings.queue_table).delete().eq('dataset_id', dataset_id).execute()

	published = client.put(
		f'/api/v1/datasets/{dataset_id}/visibility', json={'data_access': 'viewonly'}, headers=_bearer(owner)
	)
	assert published.status_code == 200
	assert published.json()['previous_data_access'] == 'private'
	assert (settings.cog_path / relative_path).is_file()

	restricted = client.put(
		f'/api/v1/datasets/{dataset_id}/visibility', json={'data_access': 'private'}, headers=_bearer(owner)
	)
	assert restricted.status_code == 200
	assert (settings.cog_path / relative_path).is_file()
	assert requests.get(f'http://nginx/cogs/v1/{relative_path}', timeout=10).status_code == 403

	with use_client(owner['token']) as db:
		events = (
			db.table('dataset_access_events')
			.select('action,old_visibility,new_visibility')
			.eq('dataset_id', dataset_id)
			.eq('action', 'visibility_changed')
			.order('id')
			.execute()
			.data
		)
	assert [(e['old_visibility'], e['new_visibility']) for e in events] == [
		('private', 'viewonly'),
		('viewonly', 'private'),
	]


@pytest.fixture
def private_dataset_with_ortho(access_accounts, data_directory, test_file):
	"""A private dataset with a real orthophoto in the archive, owned by the access owner."""
	file_name = f'private-download-{uuid.uuid4().hex[:8]}.tif'
	archive_path = settings.archive_path / file_name
	shutil.copy2(test_file, archive_path)
	with use_service_client() as db:
		dataset_id = (
			db.table(settings.datasets_table)
			.insert(
				{
					'user_id': access_accounts['owner']['id'],
					'file_name': file_name,
					'license': 'CC BY',
					'platform': 'drone',
					'authors': ['Access Test Author'],
					'data_access': 'private',
					'aquisition_year': 2025,
					'aquisition_month': 6,
					'aquisition_day': 12,
				}
			)
			.execute()
			.data[0]['id']
		)
		db.table(settings.orthos_table).insert(
			{
				'dataset_id': dataset_id,
				'ortho_file_name': file_name,
				'version': 1,
				'ortho_file_size': max(1, int(archive_path.stat().st_size / 1024 / 1024)),
				'ortho_upload_runtime': 0.1,
			}
		).execute()
		db.table(settings.statuses_table).insert(
			{'dataset_id': dataset_id, 'current_status': 'idle', 'is_upload_done': True, 'is_ortho_done': True}
		).execute()
	yield dataset_id
	shutil.rmtree(settings.downloads_path / str(dataset_id), ignore_errors=True)
	archive_path.unlink(missing_ok=True)
	with use_service_client() as db:
		db.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_private_bundle_needs_a_download_grant_and_a_signed_path(access_accounts, private_dataset_with_ortho):
	"""Private bundles are delivered only to download-capable users, on signed links."""
	dataset_id = private_dataset_with_ortho
	owner = access_accounts['owner']
	viewer, downloader = access_accounts['reader'], access_accounts['downloader']
	_grant(owner, dataset_id, viewer, 'reader')
	_grant(owner, dataset_id, downloader, 'reader', can_download=True)

	denied = client.get(f'/api/v1/download/datasets/{dataset_id}/dataset.zip', headers=_bearer(viewer))
	assert denied.status_code == 403
	assert 'download access' in denied.json()['detail']

	started = client.get(f'/api/v1/download/datasets/{dataset_id}/dataset.zip', headers=_bearer(downloader))
	assert started.status_code == 200
	status = client.get(f'/api/v1/download/datasets/{dataset_id}/status', headers=_bearer(downloader)).json()
	assert status['status'] == 'completed'
	assert status['download_path'].startswith('/api/v1/exports/')
	assert (settings.downloads_path / str(dataset_id)).exists()

	delivered = requests.get('http://nginx' + status['download_path'], timeout=10)
	assert delivered.status_code == 200
	assert delivered.headers['content-disposition'].startswith('attachment')

	# The signed path stops working when the grant loses download.
	_grant(owner, dataset_id, downloader, 'reader', can_download=False)
	assert client.get(status['download_path']).status_code == 404


def test_reader_without_download_cannot_export_labels(access_accounts, private_dataset_with_cog):
	dataset_id = private_dataset_with_cog['id']
	_grant(access_accounts['owner'], dataset_id, access_accounts['reader'], 'reader')
	for suffix in ['labels.gpkg', 'labels/status', 'labels/download']:
		response = client.get(
			f'/api/v1/download/datasets/{dataset_id}/{suffix}', headers=_bearer(access_accounts['reader'])
		)
		assert response.status_code == 403


def test_saved_public_url_and_stale_version_are_denied(access_accounts, private_dataset_with_cog):
	dataset_id = private_dataset_with_cog['id']
	relative = private_dataset_with_cog['relative_path']
	url = f'http://nginx/cogs/v1/{relative}'
	owner = access_accounts['owner']
	assert (
		client.put(
			f'/api/v1/datasets/{dataset_id}/visibility', json={'data_access': 'public'}, headers=_bearer(owner)
		).status_code
		== 200
	)
	assert requests.get(url, timeout=10).content == COG_BYTES
	with use_service_client() as db:
		db.table(settings.cogs_table).update({'cog_path': relative + '.new'}).eq('dataset_id', dataset_id).execute()
	# nginx caches the authorization briefly; a new URL proves the stale path is refused.
	assert requests.get(url + '?after-reprocessing', timeout=10).status_code == 403


def test_bundle_rechecks_every_member_and_denies_unverified_files(
	access_accounts, private_dataset_with_ortho, private_dataset_with_cog
):
	from api.src.download.delivery import export_url
	from api.src.download.jobs import ExportKind, Manifest, PreparedFileJob

	ids = (private_dataset_with_ortho, private_dataset_with_cog['id'])
	owner, downloader = access_accounts['owner'], access_accounts['downloader']
	for value in ids:
		_grant(owner, value, downloader, 'reader', can_download=True)
	job = PreparedFileJob(settings.downloads_path / 'bundles' / f'access-{uuid.uuid4().hex}.zip')
	relative = job.path.relative_to(settings.downloads_path).as_posix()
	ticket, _ = sign_ticket(downloader['id'], f'export:{relative}')
	try:
		assert job.claim()
		job.run(lambda target: target.write_bytes(b'prepared two-dataset export'), Manifest(ExportKind.DATASET, ids))
		url = export_url(job, downloader['id'])
		assert requests.get('http://nginx' + url, timeout=10).content == b'prepared two-dataset export'
		_grant(owner, ids[1], downloader, 'reader', can_download=False)
		assert requests.get('http://nginx' + url, timeout=10).status_code == 404
		# A replaced or legacy file without a matching manifest is never delivered.
		_grant(owner, ids[1], downloader, 'reader', can_download=True)
		job.path.write_bytes(b'replacement')
		assert client.get(f'/api/v1/exports/{ticket}/{relative}').status_code == 404
	finally:
		job.path.unlink(missing_ok=True)
		job.manifest_path.unlink(missing_ok=True)


def test_file_ticket_is_redacted_from_access_log():
	import logging
	from api.src.access.tickets import redact_file_tickets

	record = logging.LogRecord(
		'uvicorn.access',
		logging.INFO,
		'',
		1,
		'%s - "%s %s HTTP/%s" %d',
		('client', 'GET', '/api/v1/exports/bearer-secret/bundles/x.zip', '1.1', 200),
		None,
	)
	assert redact_file_tickets(record)
	assert 'bearer-secret' not in record.getMessage()
	assert '/exports/[redacted]/bundles/x.zip' in record.getMessage()


def test_concurrent_nginx_ranges_deliver_exact_bytes(access_accounts, private_dataset_with_cog):
	from concurrent.futures import ThreadPoolExecutor

	url = _cog_url(access_accounts['owner'], private_dataset_with_cog['id'])

	def read_range(index):
		start = index * 512
		response = requests.get(
			f'http://nginx/api/v1{url}', headers={'Range': f'bytes={start}-{start + 511}'}, timeout=15
		)
		assert response.status_code == 206
		assert response.content == COG_BYTES[start : start + 512]

	with ThreadPoolExecutor(max_workers=8) as pool:
		list(pool.map(read_range, range(16)))
