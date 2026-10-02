"""Named-user dataset access: one visibility rule across rows, children, search and RPCs.

Actors: anonymous visitor, unrelated signed-in stranger, owner (uploader), grantees
with reader, reader-with-download, editor and admin roles and an expired grantee
(``access_accounts`` in conftest). Every check runs through the caller's own Supabase session so row
security is exercised exactly as the app sees it.
"""

from datetime import datetime, timedelta, timezone
import uuid

import pytest
from postgrest.exceptions import APIError

from shared.db import use_anon_client, use_client, use_service_client
from shared.settings import settings

POLYGON = {
	'type': 'Polygon',
	'coordinates': [[[7.85, 47.99], [7.85, 48.0], [7.86, 48.0], [7.86, 47.99], [7.85, 47.99]]],
}


def _insert_dataset(owner_id: str, data_access: str, file_stem: str) -> int:
	with use_service_client() as client:
		dataset_id = (
			client.table(settings.datasets_table)
			.insert(
				{
					'user_id': owner_id,
					'file_name': f'{file_stem}.tif',
					'license': 'CC BY',
					'platform': 'drone',
					'authors': ['Access Test Author'],
					'data_access': data_access,
					'aquisition_year': 2025,
					'aquisition_month': 6,
					'aquisition_day': 12,
				}
			)
			.execute()
			.data[0]['id']
		)
		client.table(settings.orthos_table).insert(
			{
				'dataset_id': dataset_id,
				'ortho_file_name': f'{file_stem}.tif',
				'version': 1,
				'ortho_file_size': 12,
				'ortho_upload_runtime': 1.0,
				'bbox': 'BOX(7.85 47.99,7.86 48.0)',
			}
		).execute()
		client.table(settings.cogs_table).insert(
			{
				'dataset_id': dataset_id,
				'cog_file_name': f'{dataset_id}_cog.tif',
				'cog_path': f'{uuid.uuid4()}/{dataset_id}_cog.tif',
				'cog_file_size': 3,
				'version': 1,
				'cog_info': {},
				'cog_processing_runtime': 1.0,
			}
		).execute()
		client.table(settings.thumbnails_table).insert(
			{
				'dataset_id': dataset_id,
				'thumbnail_file_name': f'{dataset_id}_thumbnail.jpg',
				'thumbnail_path': f'{uuid.uuid4()}/{dataset_id}_thumbnail.jpg',
				'thumbnail_file_size': 1,
				'version': 1,
				'thumbnail_processing_runtime': 1.0,
			}
		).execute()
		client.table(settings.metadata_table).insert(
			{
				'dataset_id': dataset_id,
				'metadata': {'gadm': {'admin_level_1': 'Germany'}},
				'version': 1,
				'processing_runtime': 1.0,
			}
		).execute()
		client.table(settings.statuses_table).insert(
			{'dataset_id': dataset_id, 'is_upload_done': True, 'is_ortho_done': True, 'is_cog_done': True}
		).execute()
		label_id = (
			client.table(settings.labels_table)
			.insert(
				{
					'dataset_id': dataset_id,
					'user_id': owner_id,
					'label_source': 'model_prediction',
					'label_type': 'semantic_segmentation',
					'label_data': 'deadwood',
					'label_quality': 1,
				}
			)
			.execute()
			.data[0]['id']
		)
		client.table(settings.deadwood_geometries_table).insert(
			{'label_id': label_id, 'geometry': POLYGON, 'properties': {'fixture': file_stem}}
		).execute()
	return dataset_id


def _delete_datasets(dataset_ids: list[int]) -> None:
	with use_service_client() as client:
		for dataset_id in dataset_ids:
			client.table('jt_data_publication_datasets').delete().eq('dataset_id', dataset_id).execute()
			client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


@pytest.fixture(scope='function')
def make_dataset(access_accounts):
	"""Create owner datasets for one test and delete them (with their grants) afterwards."""
	created = []

	def make(data_access: str, file_stem: str) -> int:
		dataset_id = _insert_dataset(access_accounts['owner']['id'], data_access, file_stem)
		created.append(dataset_id)
		return dataset_id

	yield make
	_delete_datasets(created)


@pytest.fixture(scope='function')
def private_dataset(make_dataset):
	"""A private dataset with orthophoto, COG, thumbnail, metadata, status and a label."""
	return make_dataset('private', 'access-private')


def _grant(token: str, dataset_id: int, email: str, role: str, can_download: bool = False, expires_at: str | None = None):
	with use_client(token) as client:
		return (
			client.rpc(
				'set_dataset_access',
				{
					'p_dataset_id': dataset_id,
					'p_email': email,
					'p_role': role,
					'p_can_download': can_download,
					'p_expires_at': expires_at,
				},
			)
			.execute()
			.data
		)


def _access(client, dataset_id: int) -> dict | None:
	rows = client.rpc('my_dataset_access', {'p_dataset_id': dataset_id}).execute().data
	return rows[0] if rows else None


def _visible_surfaces(client, dataset_id: int) -> dict[str, bool]:
	"""Which dataset surfaces return a row for this dataset to this client."""
	surfaces = {}
	for name, table in [
		('dataset', settings.datasets_table),
		('cog', settings.cogs_table),
		('thumbnail', settings.thumbnails_table),
		('ortho', settings.orthos_table),
		('metadata', settings.metadata_table),
		('status', settings.statuses_table),
		('label', settings.labels_table),
		('full_view', 'v2_full_dataset_view'),
	]:
		key = 'id' if table in (settings.datasets_table, 'v2_full_dataset_view') else 'dataset_id'
		surfaces[name] = bool(client.table(table).select(key).eq(key, dataset_id).execute().data)
	try:
		surfaces['my_access'] = _access(client, dataset_id) is not None
	except APIError:  # not granted to anonymous visitors
		surfaces['my_access'] = False
	surfaces['search'] = bool(client.rpc('is_dataset_search_visible', {'p_dataset_id': dataset_id}).execute().data)
	return surfaces


def _grant_everyone(access_accounts, dataset_id):
	owner_token = access_accounts['owner']['token']
	_grant(owner_token, dataset_id, access_accounts['reader']['email'], 'reader')
	_grant(owner_token, dataset_id, access_accounts['downloader']['email'], 'reader', can_download=True)
	_grant(owner_token, dataset_id, access_accounts['editor']['email'], 'editor')
	_grant(owner_token, dataset_id, access_accounts['admin']['email'], 'admin')
	future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
	_grant(owner_token, dataset_id, access_accounts['expired']['email'], 'editor', expires_at=future)
	with use_service_client() as client:
		past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
		client.table('dataset_access_grants').update({'expires_at': past}).eq('dataset_id', dataset_id).eq(
			'grantee_user_id', access_accounts['expired']['id']
		).execute()


@pytest.mark.parametrize(
	'actor,expected_visible',
	[
		('anonymous', False),
		('stranger', False),
		('expired', False),
		('owner', True),
		('reader', True),
		('downloader', True),
		('editor', True),
		('admin', True),
	],
)
def test_private_dataset_surfaces_follow_one_rule(access_accounts, private_dataset, actor, expected_visible):
	"""Rows, child tables, views, search and RPCs agree for every actor."""
	_grant_everyone(access_accounts, private_dataset)
	context = use_anon_client() if actor == 'anonymous' else use_client(access_accounts[actor]['token'])
	with context as client:
		surfaces = _visible_surfaces(client, private_dataset)
	assert surfaces == {name: expected_visible for name in surfaces}, surfaces


@pytest.mark.parametrize(
	'actor,expected',
	[
		('owner', (True, None, True, True, True)),
		('reader', (False, 'reader', False, False, False)),
		('downloader', (False, 'reader', True, False, False)),
		('editor', (False, 'editor', True, True, False)),
		('admin', (False, 'admin', True, True, True)),
	],
)
def test_roles_grant_their_capabilities(access_accounts, private_dataset, actor, expected):
	"""(is_owner, role, can_download, can_edit_details, can_manage_access) per actor."""
	_grant_everyone(access_accounts, private_dataset)
	with use_client(access_accounts[actor]['token']) as client:
		access = _access(client, private_dataset)
	assert (
		access['is_owner'],
		access['role'],
		access['can_download'],
		access['can_edit_details'],
		access['can_manage_access'],
	) == expected


def test_unauthorized_caller_learns_no_more_than_for_a_missing_dataset(access_accounts, private_dataset):
	"""RPC errors and empty results are identical for a hidden and a nonexistent dataset."""
	missing_id = private_dataset + 1_000_000
	with use_client(access_accounts['stranger']['token']) as client:
		messages = []
		for dataset_id in (private_dataset, missing_id):
			assert _access(client, dataset_id) is None
			with pytest.raises(APIError) as error:
				client.rpc('list_dataset_access', {'p_dataset_id': dataset_id}).execute()
			messages.append((error.value.code, error.value.message))
			with pytest.raises(APIError) as error:
				client.rpc(
					'set_dataset_access',
					{'p_dataset_id': dataset_id, 'p_email': access_accounts['stranger']['email'], 'p_role': 'reader'},
				).execute()
			messages.append((error.value.code, error.value.message))
			with pytest.raises(APIError) as error:
				client.rpc('update_dataset_details', {'p_dataset_id': dataset_id, 'p_details': {}}).execute()
			messages.append((error.value.code, error.value.message))
		assert messages[:3] == messages[3:]


def test_grant_lifecycle_is_audited_and_revocation_is_immediate(access_accounts, private_dataset):
	owner_token = access_accounts['owner']['token']
	reader = access_accounts['reader']
	_grant(owner_token, private_dataset, reader['email'].upper(), 'reader')

	with use_client(reader['token']) as client:
		assert _access(client, private_dataset) == {
			'is_owner': False,
			'role': 'reader',
			'expires_at': None,
			'can_view': True,
			'can_download': False,
			'can_download_labels': False,
			'can_edit_details': False,
			'can_manage_access': False,
		}
		shared = client.rpc('list_datasets_shared_with_me').execute().data
		assert [(row['dataset_id'], row['can_download']) for row in shared] == [(private_dataset, False)]

	_grant(owner_token, private_dataset, reader['email'], 'reader', can_download=True)
	with use_client(reader['token']) as client:
		assert client.rpc('can_download_dataset', {'p_dataset_id': private_dataset, 'p_kind': 'dataset'}).execute().data

	with use_client(owner_token) as client:
		roster = client.rpc('list_dataset_access', {'p_dataset_id': private_dataset}).execute().data
		assert [(row['email'], row['is_owner'], row['role'], row['can_download']) for row in roster] == [
			(access_accounts['owner']['email'], True, None, True),
			(reader['email'], False, 'reader', True),
		]
		assert client.rpc(
			'revoke_dataset_access', {'p_dataset_id': private_dataset, 'p_user_id': reader['id']}
		).execute().data
		events = (
			client.table('dataset_access_events')
			.select('action,old_role,new_role,old_can_download,new_can_download,actor_user_id')
			.eq('dataset_id', private_dataset)
			.order('id')
			.execute()
			.data
		)
	assert [
		(event['action'], event['old_role'], event['new_role'], event['old_can_download'], event['new_can_download'])
		for event in events
	] == [
		('granted', None, 'reader', None, False),
		('changed', 'reader', 'reader', False, True),
		('revoked', 'reader', None, True, None),
	]
	assert {event['actor_user_id'] for event in events} == {access_accounts['owner']['id']}

	with use_client(reader['token']) as client:
		assert _visible_surfaces(client, private_dataset)['dataset'] is False
		assert client.rpc('list_datasets_shared_with_me').execute().data == []


def test_editors_and_admins_always_download(access_accounts, private_dataset):
	_grant(access_accounts['owner']['token'], private_dataset, access_accounts['editor']['email'], 'editor', False)
	with use_service_client() as client:
		row = (
			client.table('dataset_access_grants')
			.select('can_download')
			.eq('dataset_id', private_dataset)
			.eq('grantee_user_id', access_accounts['editor']['id'])
			.single()
			.execute()
			.data
		)
	assert row['can_download'] is True


def test_grant_rules_protect_owner_self_and_expiry(access_accounts, private_dataset):
	owner_token = access_accounts['owner']['token']
	with use_client(owner_token) as client:
		for email, expires_at in [
			(access_accounts['owner']['email'], None),
			('nobody-registered@example.com', None),
			(access_accounts['reader']['email'], (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()),
		]:
			with pytest.raises(APIError):
				client.rpc(
					'set_dataset_access',
					{'p_dataset_id': private_dataset, 'p_email': email, 'p_role': 'reader', 'p_expires_at': expires_at},
				).execute()

	# Direct table writes are not granted, not even to the owner.
	with use_client(owner_token) as client:
		with pytest.raises(APIError):
			client.table('dataset_access_grants').insert(
				{'dataset_id': private_dataset, 'grantee_user_id': access_accounts['reader']['id'], 'role': 'admin'}
			).execute()

	# An admin administers peers but cannot change their own access or the owner's.
	_grant(owner_token, private_dataset, access_accounts['admin']['email'], 'admin')
	admin_token = access_accounts['admin']['token']
	_grant(admin_token, private_dataset, access_accounts['reader']['email'], 'reader')
	with use_client(admin_token) as client:
		for email in (access_accounts['admin']['email'], access_accounts['owner']['email']):
			with pytest.raises(APIError):
				client.rpc(
					'set_dataset_access', {'p_dataset_id': private_dataset, 'p_email': email, 'p_role': 'reader'}
				).execute()
		roster = client.rpc('list_dataset_access', {'p_dataset_id': private_dataset}).execute().data
		assert {row['email'] for row in roster} == {
			access_accounts['owner']['email'],
			access_accounts['admin']['email'],
			access_accounts['reader']['email'],
		}
		# Admins manage access, but visibility stays with the owner.
		with pytest.raises(APIError):
			client.rpc('set_dataset_visibility', {'p_dataset_id': private_dataset, 'p_data_access': 'public'}).execute()

	# Readers and editors do not see the roster; a grantee may leave on their own.
	_grant(owner_token, private_dataset, access_accounts['editor']['email'], 'editor')
	with use_client(access_accounts['editor']['token']) as client:
		with pytest.raises(APIError):
			client.rpc('list_dataset_access', {'p_dataset_id': private_dataset}).execute()
	with use_client(access_accounts['reader']['token']) as client:
		with pytest.raises(APIError):
			client.rpc('list_dataset_access', {'p_dataset_id': private_dataset}).execute()
		own_rows = client.table('dataset_access_grants').select('grantee_user_id').execute().data
		assert {row['grantee_user_id'] for row in own_rows} == {access_accounts['reader']['id']}
		assert client.rpc(
			'revoke_dataset_access', {'p_dataset_id': private_dataset, 'p_user_id': access_accounts['reader']['id']}
		).execute().data


def test_editors_change_only_descriptive_details(access_accounts, private_dataset):
	owner_token = access_accounts['owner']['token']
	_grant(owner_token, private_dataset, access_accounts['editor']['email'], 'editor')
	_grant(owner_token, private_dataset, access_accounts['reader']['email'], 'reader', can_download=True)

	with use_client(access_accounts['editor']['token']) as client:
		updated = (
			client.rpc(
				'update_dataset_details',
				{
					'p_dataset_id': private_dataset,
					'p_details': {'authors': ['Editor Author'], 'aquisition_year': 2024, 'citation_doi': '10.1/x'},
				},
			)
			.execute()
			.data
		)
		assert updated['authors'] == ['Editor Author'] and updated['aquisition_year'] == 2024
		for details in ({'data_access': 'public'}, {'user_id': access_accounts['editor']['id']}, {'archived': True}):
			with pytest.raises(APIError):
				client.rpc('update_dataset_details', {'p_dataset_id': private_dataset, 'p_details': details}).execute()
		# Grants never open the row-level update path.
		assert (
			client.table(settings.datasets_table)
			.update({'additional_information': 'direct'})
			.eq('id', private_dataset)
			.execute()
			.data
			== []
		)

	with use_client(access_accounts['reader']['token']) as client:
		with pytest.raises(APIError):
			client.rpc(
				'update_dataset_details', {'p_dataset_id': private_dataset, 'p_details': {'authors': ['Reader']}}
			).execute()

	with use_client(owner_token) as client:
		client.rpc(
			'update_dataset_details', {'p_dataset_id': private_dataset, 'p_details': {'additional_information': 'mine'}}
		).execute()


def test_archiving_suspends_grants_but_not_the_owner(access_accounts, private_dataset):
	_grant(access_accounts['owner']['token'], private_dataset, access_accounts['admin']['email'], 'admin')
	with use_service_client() as client:
		client.table(settings.datasets_table).update({'archived': True}).eq('id', private_dataset).execute()
	with use_client(access_accounts['admin']['token']) as client:
		assert _visible_surfaces(client, private_dataset)['dataset'] is False
		assert _access(client, private_dataset) is None
	with use_client(access_accounts['owner']['token']) as client:
		assert _access(client, private_dataset)['is_owner'] is True


@pytest.mark.parametrize(
	'data_access,kind,expected',
	[
		('public', 'dataset', {'stranger': True, 'owner': True, 'reader': True, 'downloader': True}),
		('viewonly', 'dataset', {'stranger': False, 'owner': True, 'reader': False, 'downloader': True}),
		('private', 'dataset', {'stranger': False, 'owner': True, 'reader': False, 'downloader': True}),
		('public', 'labels', {'stranger': True, 'owner': True, 'reader': True, 'downloader': True}),
		('viewonly', 'labels', {'stranger': True, 'owner': True, 'reader': True, 'downloader': True}),
		('private', 'labels', {'stranger': False, 'owner': True, 'reader': False, 'downloader': True}),
	],
)
def test_download_rules_by_visibility_and_export_kind(access_accounts, make_dataset, data_access, kind, expected):
	"""View-only keeps predictions downloadable; orthophotos need public, ownership or a download grant."""
	dataset_id = make_dataset(data_access, f'access-download-{data_access}-{kind}')
	_grant(access_accounts['owner']['token'], dataset_id, access_accounts['reader']['email'], 'reader')
	_grant(access_accounts['owner']['token'], dataset_id, access_accounts['downloader']['email'], 'reader', True)
	actual = {}
	for actor in expected:
		with use_client(access_accounts[actor]['token']) as client:
			actual[actor] = client.rpc('can_download_dataset', {'p_dataset_id': dataset_id, 'p_kind': kind}).execute().data
	with use_service_client() as client:
		service_view = {
			actor: client.rpc(
				'user_can_download_datasets',
				{'p_dataset_ids': [dataset_id], 'p_kind': kind, 'p_user_id': access_accounts[actor]['id']},
			)
			.execute()
			.data
			for actor in expected
		}
	assert actual == expected
	assert service_view == expected


def test_anonymous_callers_never_download(access_accounts, make_dataset):
	dataset_id = make_dataset('public', 'access-download-anonymous')
	with use_anon_client() as client:
		with pytest.raises(APIError):
			client.rpc('can_download_dataset', {'p_dataset_id': dataset_id, 'p_kind': 'labels'}).execute()
	with use_service_client() as client:
		assert (
			client.rpc(
				'user_can_download_datasets', {'p_dataset_ids': [dataset_id], 'p_kind': 'labels', 'p_user_id': None}
			)
			.execute()
			.data
			is False
		)


def test_static_file_urls_serve_only_current_files_of_visible_datasets(make_dataset):
	public_id = make_dataset('public', 'access-static-public')
	private_id = make_dataset('private', 'access-static-private')
	with use_service_client() as client:
		paths = {
			dataset_id: client.table(settings.cogs_table).select('cog_path').eq('dataset_id', dataset_id).single().execute().data['cog_path']
			for dataset_id in (public_id, private_id)
		}

		def allowed(kind, path):
			return client.rpc('is_public_dataset_file', {'p_kind': kind, 'p_path': path}).execute().data

		assert allowed('cog', paths[public_id]) is True
		assert allowed('cog', paths[private_id]) is False
		assert allowed('thumbnail', paths[public_id]) is False  # a COG path is not a thumbnail
		assert allowed('cog', 'missing/never.tif') is False
	with use_anon_client() as client:
		with pytest.raises(APIError):
			client.rpc('is_public_dataset_file', {'p_kind': 'cog', 'p_path': paths[public_id]}).execute()


def test_visibility_changes_require_the_audited_function(access_accounts, private_dataset):
	"""Direct row updates cannot bypass the audited visibility function."""
	with use_client(access_accounts['owner']['token']) as client:
		with pytest.raises(APIError):
			client.table(settings.datasets_table).update({'data_access': 'public'}).eq('id', private_dataset).execute()
		# Other owner edits keep working.
		client.table(settings.datasets_table).update({'additional_information': 'edited'}).eq(
			'id', private_dataset
		).execute()
		assert (
			client.rpc('set_dataset_visibility', {'p_dataset_id': private_dataset, 'p_data_access': 'viewonly'})
			.execute()
			.data
			== 'private'
		)
		row = client.table(settings.datasets_table).select('data_access').eq('id', private_dataset).single().execute().data
	assert row['data_access'] == 'viewonly'


def test_publication_links_do_not_reveal_private_datasets(access_accounts, private_dataset):
	with use_service_client() as client:
		publication_id = (
			client.table('data_publication')
			.insert({'title': 'Access test', 'description': 'Private link', 'user_id': access_accounts['owner']['id']})
			.execute()
			.data[0]['id']
		)
		client.table('jt_data_publication_datasets').insert(
			{'publication_id': publication_id, 'dataset_id': private_dataset}
		).execute()

	for context in (use_anon_client(), use_client(access_accounts['stranger']['token'])):
		with context as client:
			links = (
				client.table('jt_data_publication_datasets')
				.select('dataset_id')
				.eq('publication_id', publication_id)
				.execute()
				.data
			)
			assert links == []
	with use_client(access_accounts['owner']['token']) as client:
		links = client.table('jt_data_publication_datasets').select('dataset_id').eq('publication_id', publication_id).execute().data
		assert links == [{'dataset_id': private_dataset}]


def test_concurrent_visibility_changes_have_a_serial_audit_history(access_accounts, private_dataset):
	from concurrent.futures import ThreadPoolExecutor

	def change(value):
		with use_client(access_accounts['owner']['token']) as db:
			return (
				db.rpc('set_dataset_visibility', {'p_dataset_id': private_dataset, 'p_data_access': value})
				.execute()
				.data
			)

	with ThreadPoolExecutor(max_workers=2) as pool:
		list(pool.map(change, ['public', 'viewonly']))
	with use_service_client() as db:
		row = db.table(settings.datasets_table).select('data_access').eq('id', private_dataset).single().execute().data
		events = (
			db.table('dataset_access_events')
			.select('old_visibility,new_visibility')
			.eq('dataset_id', private_dataset)
			.eq('action', 'visibility_changed')
			.order('id')
			.execute()
			.data
		)
	assert len(events) == 2
	assert events[0]['old_visibility'] == 'private'
	assert events[1]['old_visibility'] == events[0]['new_visibility']
	assert row['data_access'] == events[1]['new_visibility']


def test_revoked_admin_cannot_finish_a_waiting_grant(access_accounts, private_dataset):
	"""Force a grant call to wait while its admin loses access, then release it."""
	import json
	import time
	from concurrent.futures import ThreadPoolExecutor
	from urllib.parse import urlparse
	import psycopg

	assert urlparse(settings.SUPABASE_DB_URL).hostname in {'localhost', '127.0.0.1', 'host.docker.internal'}
	owner, admin, stranger = access_accounts['owner'], access_accounts['admin'], access_accounts['stranger']
	_grant(owner['token'], private_dataset, admin['email'], 'admin')
	name = f'access-race-{uuid.uuid4().hex}'

	def grant_waiting():
		with psycopg.connect(settings.SUPABASE_DB_URL, user='supabase_admin', application_name=name) as db:
			db.execute(
				"select set_config('request.jwt.claims', %s, true)",
				(json.dumps({'sub': admin['id'], 'role': 'authenticated'}),),
			)
			db.execute('set local role authenticated')
			db.execute("select * from public.set_dataset_access(%s, %s, 'reader')", (private_dataset, stranger['email']))

	with psycopg.connect(settings.SUPABASE_DB_URL, user='supabase_admin') as owner_db:
		owner_db.execute('select id from public.v2_datasets where id = %s for update', (private_dataset,))
		with ThreadPoolExecutor(max_workers=1) as pool:
			future = pool.submit(grant_waiting)
			try:
				deadline = time.monotonic() + 10
				while time.monotonic() < deadline:
					owner_db.execute('select pg_stat_clear_snapshot()')
					waiting = owner_db.execute(
						"select 1 from pg_stat_activity where application_name = %s and wait_event_type = 'Lock'",
						(name,),
					).fetchone()
					if waiting:
						break
					time.sleep(0.02)
				assert waiting, 'grant call did not reach the dataset lock'
				owner_db.execute(
					"select set_config('request.jwt.claims', %s, true)",
					(json.dumps({'sub': owner['id'], 'role': 'authenticated'}),),
				)
				owner_db.execute('select public.revoke_dataset_access(%s, %s)', (private_dataset, admin['id']))
				owner_db.commit()
			finally:
				owner_db.rollback()  # Always release the lock before joining the worker.
			with pytest.raises(psycopg.errors.NoDataFound):
				future.result(timeout=10)
	with use_service_client() as db:
		assert (
			not db.table('dataset_access_grants')
			.select('id')
			.eq('dataset_id', private_dataset)
			.eq('grantee_user_id', stranger['id'])
			.execute()
			.data
		)
