"""COG paths are listed only to bulk readers; everyone else gets one capped path per dataset."""

import uuid

import pytest
from fastapi.testclient import TestClient

from api.src.access import cog_paths
from api.src.server import app
from shared.db import use_anon_client, use_client, use_service_client
from shared.settings import settings

client = TestClient(app)


def _bearer(account: dict) -> dict:
	return {'Authorization': f"Bearer {account['token']}"}


def _create_dataset(owner_id: str, data_access: str) -> tuple[int, str]:
	relative_path = f'{uuid.uuid4()}/{uuid.uuid4().hex[:6]}_cog.tif'
	with use_service_client() as db:
		dataset_id = (
			db.table(settings.datasets_table)
			.insert(
				{
					'user_id': owner_id,
					'file_name': f'{data_access}-cog-path.tif',
					'license': 'CC BY',
					'platform': 'drone',
					'authors': ['Cog Path Test'],
					'data_access': data_access,
					'aquisition_year': 2025,
					'aquisition_month': 6,
					'aquisition_day': 12,
				}
			)
			.execute()
			.data[0]['id']
		)
		db.table(settings.cogs_table).insert(
			{'dataset_id': dataset_id, 'cog_file_name': 'cog.tif', 'cog_path': relative_path, 'cog_file_size': 1, 'version': 1}
		).execute()
		db.table(settings.statuses_table).insert(
			{'dataset_id': dataset_id, 'current_status': 'idle', 'is_cog_done': True}
		).execute()
	return dataset_id, relative_path


@pytest.fixture(scope='module')
def datasets(access_accounts):
	owner = access_accounts['owner']
	public_id, public_path = _create_dataset(owner['id'], 'public')
	private_id, _ = _create_dataset(owner['id'], 'private')
	yield {'public': (public_id, public_path), 'private': (private_id, None)}
	with use_service_client() as db:
		db.table('cog_path_requests').delete().in_('dataset_id', [public_id, private_id]).execute()


@pytest.fixture(autouse=True)
def clean_requests():
	with use_service_client() as db:
		db.table('cog_path_requests').delete().neq('id', 0).execute()


def _listed_path(token: str | None, dataset_id: int) -> str | None:
	with use_client(token) if token else use_anon_client() as db:
		rows = db.table(settings.cogs_table).select('cog_path').eq('dataset_id', dataset_id).execute().data
		view = db.table('v2_full_dataset_view_public').select('cog_path').eq('id', dataset_id).execute().data
	view_path = view[0]['cog_path'] if view else None
	table_path = rows[0]['cog_path'] if rows else None
	assert view_path == table_path, 'the public view must expose exactly what the table does'
	return table_path


def test_public_cog_paths_are_not_listed_to_visitors_or_strangers(access_accounts, datasets):
	public_id, public_path = datasets['public']
	assert _listed_path(None, public_id) is None
	assert _listed_path(access_accounts['stranger']['token'], public_id) is None
	assert _listed_path(access_accounts['owner']['token'], public_id) == public_path


def test_staff_and_priwa_members_still_list_paths(access_accounts, datasets):
	public_id, public_path = datasets['public']
	private_id, _ = datasets['private']
	auditor, member, operator = access_accounts['admin'], access_accounts['editor'], access_accounts['reader']
	project_id = str(uuid.uuid4())
	with use_service_client() as db:
		db.table('privileged_users').insert(
			[
				{'user_id': auditor['id'], 'can_audit': True, 'can_operate': False},
				{'user_id': operator['id'], 'can_audit': False, 'can_operate': True},
			]
		).execute()
		db.table('priwa_projects').insert({'id': project_id, 'slug': f'cog-{project_id}', 'name': 'Cog paths'}).execute()
		db.table('priwa_project_memberships').insert(
			{'project_id': project_id, 'user_id': member['id'], 'role': 'field_user'}
		).execute()
	try:
		assert _listed_path(member['token'], public_id) == public_path
		with use_client(member['token']) as db:
			private_rows = db.table(settings.cogs_table).select('cog_path').eq('dataset_id', private_id).execute().data
		assert private_rows == [], 'PRIWA members must not see private datasets of others'
		for account in (auditor, operator):
			assert _listed_path(account['token'], public_id) == public_path
			with use_client(account['token']) as db:
				rows = db.table(settings.cogs_table).select('cog_path').eq('dataset_id', private_id).execute().data
			assert rows == [], 'auditors and operators keep their private-dataset visibility'
	finally:
		with use_service_client() as db:
			db.table('privileged_users').delete().in_('user_id', [auditor['id'], operator['id']]).execute()
			db.table('priwa_project_memberships').delete().eq('project_id', project_id).execute()
			db.table('priwa_projects').delete().eq('id', project_id).execute()


def test_endpoint_hands_out_public_paths_and_hides_private_ones(access_accounts, datasets):
	public_id, public_path = datasets['public']
	private_id, _ = datasets['private']
	response = client.get(f'/api/v1/datasets/{public_id}/files/cog')
	assert response.status_code == 200
	assert response.json() == {'cog_path': public_path}
	for headers in ({}, _bearer(access_accounts['owner'])):
		assert client.get(f'/api/v1/datasets/{private_id}/files/cog', headers=headers).status_code == 404
	assert client.get('/api/v1/datasets/999999999/files/cog').status_code == 404


def test_endpoint_caps_distinct_datasets_per_requester(access_accounts, datasets, monkeypatch):
	public_id, _ = datasets['public']
	other_id, _ = _create_dataset(access_accounts['owner']['id'], 'public')
	monkeypatch.setattr(settings, 'COG_PATHS_PER_DAY', 1)
	stranger = _bearer(access_accounts['stranger'])

	assert client.get(f'/api/v1/datasets/{public_id}/files/cog', headers=stranger).status_code == 200
	assert client.get(f'/api/v1/datasets/{public_id}/files/cog', headers=stranger).status_code == 200, 'reopening is free'
	assert client.get(f'/api/v1/datasets/{other_id}/files/cog', headers=stranger).status_code == 429
	# Accounts and anonymous visitors have separate allowances.
	assert client.get(f'/api/v1/datasets/{other_id}/files/cog').status_code == 200
	assert client.get(f'/api/v1/datasets/{public_id}/files/cog').status_code == 429


def test_invalid_token_is_rejected_not_treated_as_anonymous(datasets):
	public_id, _ = datasets['public']
	response = client.get(f'/api/v1/datasets/{public_id}/files/cog', headers={'Authorization': 'Bearer invalid'})
	assert response.status_code == 401


def test_requester_keys_never_store_raw_ips():
	key = cog_paths.requester_key(None, '198.51.100.7')
	assert key.startswith('ip:') and '198.51.100.7' not in key
	assert key == cog_paths.requester_key(None, '198.51.100.7')
	assert cog_paths.requester_key('user-1', '198.51.100.7') == 'user:user-1'


def test_queue_estimates_still_average_every_cog(access_accounts, datasets):
	owner, stranger = access_accounts['owner'], access_accounts['stranger']
	public_id, _ = datasets['public']
	stranger_dataset, _ = _create_dataset(stranger['id'], 'public')
	with use_service_client() as db:
		db.table(settings.cogs_table).update({'cog_processing_runtime': 10.0}).eq('dataset_id', public_id).execute()
		db.table(settings.cogs_table).update({'cog_processing_runtime': 30.0}).eq('dataset_id', stranger_dataset).execute()
		rows = db.table(settings.cogs_table).select('cog_processing_runtime').execute().data
		runtimes = [row['cog_processing_runtime'] for row in rows if row['cog_processing_runtime'] is not None]
		expected = sum(runtimes) / len(runtimes)
		queued = db.table(settings.queue_table).insert(
			{'dataset_id': public_id, 'user_id': owner['id'], 'task_types': ['metadata']}
		).execute().data[0]
	try:
		with use_client(owner['token']) as db:
			rows = db.table('v2_queue_positions').select('avg').eq('dataset_id', public_id).execute().data
		assert rows and rows[0]['avg'] == pytest.approx(expected)
	finally:
		with use_service_client() as db:
			db.table(settings.queue_table).delete().eq('id', queued['id']).execute()
			db.table(settings.datasets_table).delete().eq('id', stranger_dataset).execute()


def test_parallel_requests_cannot_exceed_the_cap(access_accounts, monkeypatch):
	from concurrent.futures import ThreadPoolExecutor

	ids = [_create_dataset(access_accounts['owner']['id'], 'public')[0] for _ in range(6)]
	monkeypatch.setattr(settings, 'COG_PATHS_PER_DAY', 2)
	headers = _bearer(access_accounts['stranger'])
	with ThreadPoolExecutor(max_workers=6) as pool:
		statuses = list(pool.map(lambda i: client.get(f'/api/v1/datasets/{i}/files/cog', headers=headers).status_code, ids))
	assert sorted(statuses) == [200, 200, 429, 429, 429, 429]
