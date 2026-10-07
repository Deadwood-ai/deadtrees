"""Private PRIWA flights stay readable inside their project and nowhere else.

Actors (``access_accounts``): the uploader ("owner") and a second member ("reader")
of an isolated PRIWA project, plus a signed-in non-member ("stranger").
"""

import uuid

import pytest

from api.tests.db.test_priwa_field_schema import create_processed_priwa_flight
from shared.db import use_client, use_service_client
from shared.settings import settings

MOSAICS_RPC = 'priwa_project_latest_flight_mosaics'


@pytest.fixture
def project(access_accounts):
	"""A PRIWA project whose uploader contributes flights and whose reader is a member."""
	project_id = str(uuid.uuid4())
	with use_service_client() as client:
		client.table('priwa_projects').insert(
			{'id': project_id, 'slug': f'test-priwa-{project_id}', 'name': 'Test PRIWA Project'}
		).execute()
		client.table('priwa_project_memberships').insert(
			[
				{'project_id': project_id, 'user_id': access_accounts['owner']['id'], 'role': 'field_user'},
				{'project_id': project_id, 'user_id': access_accounts['reader']['id'], 'role': 'field_user'},
			]
		).execute()
	try:
		yield project_id
	finally:
		with use_service_client() as client:
			client.table('priwa_project_memberships').delete().eq('project_id', project_id).execute()
			client.table('priwa_projects').delete().eq('id', project_id).execute()


@pytest.fixture
def private_flight(access_accounts):
	"""A processed private drone flight uploaded by the project member."""
	with use_service_client() as client:
		dataset_id = create_processed_priwa_flight(client, access_accounts['owner']['id'], 'priwa-private-flight')
		client.table(settings.datasets_table).update({'data_access': 'private'}).eq('id', dataset_id).execute()
	try:
		yield dataset_id
	finally:
		with use_service_client() as client:
			client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def _sees(account: dict, project_id: str, dataset_id: int) -> dict:
	"""What one account can read of a dataset through the app's own session."""
	with use_client(account['token']) as client:
		mosaic_ids = [
			row['id']
			for row in client.rpc(MOSAICS_RPC, {'p_project_id': project_id, 'p_limit': 100, 'p_offset': 0})
			.execute()
			.data
		]
		dataset = client.table(settings.datasets_table).select('id').eq('id', dataset_id).execute().data
		cog = client.table(settings.cogs_table).select('cog_path').eq('dataset_id', dataset_id).execute().data
		access = client.rpc('my_dataset_access', {'p_dataset_id': dataset_id}).execute().data
	with use_service_client() as client:
		can_view = client.rpc(
			'user_can_view_dataset', {'p_dataset_id': dataset_id, 'p_user_id': account['id']}
		).execute().data
	return {
		'mosaic': str(dataset_id) in mosaic_ids,
		'dataset': bool(dataset),
		'cog': bool(cog),
		'access': access[0] if access else None,
		'file_ticket': can_view,
	}


def test_project_members_read_a_private_flight_without_download(access_accounts, project, private_flight):
	member = _sees(access_accounts['reader'], project, private_flight)
	assert member['mosaic'] and member['dataset'] and member['cog'] and member['file_ticket']
	assert member['access']['role'] == 'reader'
	assert member['access']['can_download'] is False
	assert member['access']['can_download_labels'] is False
	assert member['access']['can_manage_access'] is False

	stranger = _sees(access_accounts['stranger'], project, private_flight)
	assert stranger == {'mosaic': False, 'dataset': False, 'cog': False, 'access': None, 'file_ticket': False}


def test_members_who_do_not_contribute_flights_share_nothing(access_accounts, project, private_flight):
	with use_service_client() as client:
		client.table('priwa_project_memberships').update({'contributes_flights': False}).eq(
			'project_id', project
		).eq('user_id', access_accounts['owner']['id']).execute()

	member = _sees(access_accounts['reader'], project, private_flight)
	assert member == {'mosaic': False, 'dataset': False, 'cog': False, 'access': None, 'file_ticket': False}


def test_only_drone_flights_are_shared(access_accounts, project, private_flight):
	with use_service_client() as client:
		client.table(settings.datasets_table).update({'platform': 'airborne'}).eq('id', private_flight).execute()

	assert _sees(access_accounts['reader'], project, private_flight)['dataset'] is False


def test_leaving_the_project_ends_access(access_accounts, project, private_flight):
	with use_service_client() as client:
		client.table('priwa_project_memberships').delete().eq('project_id', project).eq(
			'user_id', access_accounts['reader']['id']
		).execute()

	member = _sees(access_accounts['reader'], project, private_flight)
	assert member['dataset'] is False and member['file_ticket'] is False


def test_members_cannot_add_themselves_to_a_project(access_accounts, project):
	with use_client(access_accounts['stranger']['token']) as client:
		with pytest.raises(Exception):
			client.table('priwa_project_memberships').insert(
				{'project_id': project, 'user_id': access_accounts['stranger']['id'], 'role': 'field_user'}
			).execute()


def test_public_flights_carry_no_project_role(access_accounts, project, private_flight):
	with use_service_client() as client:
		client.table(settings.datasets_table).update({'data_access': 'public'}).eq('id', private_flight).execute()

	member = _sees(access_accounts['reader'], project, private_flight)
	assert member['mosaic'] and member['dataset']
	assert member['access']['role'] is None


def test_uploaders_in_several_projects_share_with_none(access_accounts, project, private_flight):
	other_project = str(uuid.uuid4())
	with use_service_client() as client:
		client.table('priwa_projects').insert(
			{'id': other_project, 'slug': f'test-priwa-{other_project}', 'name': 'Other PRIWA Project'}
		).execute()
		client.table('priwa_project_memberships').insert(
			{'project_id': other_project, 'user_id': access_accounts['owner']['id'], 'role': 'field_user'}
		).execute()
	try:
		assert _sees(access_accounts['reader'], project, private_flight)['dataset'] is False
	finally:
		with use_service_client() as client:
			client.table('priwa_project_memberships').delete().eq('project_id', other_project).execute()
			client.table('priwa_projects').delete().eq('id', other_project).execute()
