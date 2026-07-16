from datetime import datetime, timezone
import uuid

import pytest

from shared.db import login, use_client, use_service_client
from shared.settings import settings


def priwa_point(lon=8.2044, lat=48.4064):
	"""Return a GeoJSON point near the PRIWA Renchtal field area."""
	return {'type': 'Point', 'coordinates': [lon, lat]}


def kaeferbaum_payload(project_id, **overrides):
	"""Build a valid default Käferbaum payload with optional field overrides."""
	payload = {
		'project_id': project_id,
		'geom': priwa_point(),
		'location_source': 'qr_exact',
		'baumnr': None,
		'fund': 'fresh',
		'baumart': 'Fichte',
		'bm': 'ja',
		'bohrloch': 'nein',
		'harz': 'ja',
		'nadel': 'braun',
		'rinde': None,
		'kv': None,
		'name': 'Test Observer',
		'datum': '2026-05-19',
		'kom': 'Local PRIWA schema smoke',
		'raw_qr_value': 'https://maps.google.com/?q=48.4064,8.2044',
	}
	payload.update(overrides)
	return payload


@pytest.fixture(scope='function')
def priwa_project(test_user, test_user2):
	"""Create an isolated PRIWA project with one member and one non-member."""
	project_id = str(uuid.uuid4())
	slug = f'test-priwa-{project_id}'

	with use_service_client() as client:
		client.table('priwa_projects').insert(
			{
				'id': project_id,
				'slug': slug,
				'name': 'Test PRIWA Project',
			}
		).execute()
		client.table('priwa_project_memberships').insert(
			{
				'project_id': project_id,
				'user_id': test_user,
				'role': 'field_user',
			}
		).execute()

	try:
		yield {'id': project_id, 'slug': slug, 'member_id': test_user, 'non_member_id': test_user2}
	finally:
		with use_service_client() as client:
			client.table('priwa_befallsgruppen').delete().eq('project_id', project_id).execute()
			client.table('priwa_kaeferbaeume').delete().eq('project_id', project_id).execute()
			client.table('priwa_project_memberships').delete().eq('project_id', project_id).execute()
			client.table('priwa_projects').delete().eq('id', project_id).execute()


def test_priwa_membership_gates_projects_and_kaeferbaeume(priwa_project, test_user):
	"""Members can read project records while non-members see no PRIWA data."""
	member_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)
	non_member_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)
	kaeferbaum_id = str(uuid.uuid4())

	with use_service_client() as client:
		client.table('priwa_kaeferbaeume').insert(
			kaeferbaum_payload(
				priwa_project['id'],
				id=kaeferbaum_id,
				created_by=test_user,
				updated_by=test_user,
			)
		).execute()

	with use_client(member_token) as client:
		projects = client.table('priwa_projects').select('*').eq('id', priwa_project['id']).execute()
		memberships = (
			client.table('priwa_project_memberships').select('*').eq('project_id', priwa_project['id']).execute()
		)
		records = client.table('priwa_kaeferbaeume').select('*').eq('id', kaeferbaum_id).execute()

	assert len(projects.data) == 1
	assert len(memberships.data) == 1
	assert len(records.data) == 1
	assert records.data[0]['is_exact_location'] is True

	with use_client(non_member_token) as client:
		projects = client.table('priwa_projects').select('*').eq('id', priwa_project['id']).execute()
		memberships = (
			client.table('priwa_project_memberships').select('*').eq('project_id', priwa_project['id']).execute()
		)
		records = client.table('priwa_kaeferbaeume').select('*').eq('id', kaeferbaum_id).execute()

	assert projects.data == []
	assert memberships.data == []
	assert records.data == []


def test_priwa_member_can_create_update_and_soft_delete_kaeferbaum(priwa_project):
	"""Members can write current-state records and soft-delete them only by update."""
	member_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(member_token) as client:
		inserted = client.table('priwa_kaeferbaeume').insert(
			kaeferbaum_payload(priwa_project['id'])
		).execute()

	created = inserted.data[0]
	assert created['created_by'] == priwa_project['member_id']
	assert created['updated_by'] == priwa_project['member_id']

	with use_client(member_token) as client:
		updated = (
			client.table('priwa_kaeferbaeume')
			.update({'baumnr': 'KB-001', 'fund': 'kontrolliert'})
			.eq('id', created['id'])
			.execute()
		)

	assert updated.data[0]['baumnr'] == 'KB-001'
	assert updated.data[0]['updated_by'] == priwa_project['member_id']

	with use_client(member_token) as client:
		delete_attempt = client.table('priwa_kaeferbaeume').delete().eq('id', created['id']).execute()
		after_delete_attempt = client.table('priwa_kaeferbaeume').select('*').eq('id', created['id']).execute()

		client.table('priwa_kaeferbaeume').update(
			{'deleted_at': datetime.now(timezone.utc).isoformat()}
		).eq('id', created['id']).execute()
		member_records_after_soft_delete = (
			client.table('priwa_kaeferbaeume')
			.select('deleted_at,deleted_by,fund')
			.eq('id', created['id'])
			.execute()
		)
		blocked_update = (
			client.table('priwa_kaeferbaeume')
			.update({'fund': 'should-not-change'})
			.eq('id', created['id'])
			.execute()
		)

	assert delete_attempt.data == []
	assert len(after_delete_attempt.data) == 1
	assert len(member_records_after_soft_delete.data) == 1
	assert member_records_after_soft_delete.data[0]['deleted_at'] is not None
	assert blocked_update.data == []

	with use_service_client() as client:
		soft_deleted = (
			client.table('priwa_kaeferbaeume')
			.select('deleted_at,deleted_by,fund')
			.eq('id', created['id'])
			.single()
			.execute()
		)

	assert soft_deleted.data['deleted_at'] is not None
	assert soft_deleted.data['deleted_by'] == priwa_project['member_id']
	assert soft_deleted.data['fund'] == 'kontrolliert'


def test_priwa_kaeferbaum_identity_project_and_server_timestamps_are_locked(priwa_project):
	"""Client writes cannot move a record, replace its id, or forge server timestamps."""
	member_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)
	client_timestamp = '2000-01-01T00:00:00+00:00'

	with use_client(member_token) as client:
		inserted = client.table('priwa_kaeferbaeume').insert(
			kaeferbaum_payload(
				priwa_project['id'],
				created_at=client_timestamp,
				updated_at=client_timestamp,
			)
		).execute()

	created = inserted.data[0]
	replacement_id = str(uuid.uuid4())
	replacement_project_id = str(uuid.uuid4())

	assert not created['created_at'].startswith('2000-01-01')
	assert not created['updated_at'].startswith('2000-01-01')

	with use_client(member_token) as client:
		updated = (
			client.table('priwa_kaeferbaeume')
			.update(
				{
					'id': replacement_id,
					'project_id': replacement_project_id,
					'fund': 'kontrolliert',
				}
			)
			.eq('id', created['id'])
			.execute()
		)

	assert updated.data[0]['id'] == created['id']
	assert updated.data[0]['project_id'] == priwa_project['id']
	assert updated.data[0]['fund'] == 'kontrolliert'

	with use_service_client() as client:
		replacement_records = client.table('priwa_kaeferbaeume').select('id').eq('id', replacement_id).execute()

	assert replacement_records.data == []


def test_priwa_kaeferbaum_requires_baumnr_for_estimated_locations(priwa_project):
	"""Estimated GPS or map locations require a tree number for later matching."""
	member_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(member_token) as client:
		with pytest.raises(Exception):
			client.table('priwa_kaeferbaeume').insert(
				kaeferbaum_payload(
					priwa_project['id'],
					location_source='gps_estimated',
					baumnr=None,
					raw_qr_value=None,
				)
			).execute()

		inserted = client.table('priwa_kaeferbaeume').insert(
			kaeferbaum_payload(
				priwa_project['id'],
				location_source='map_estimated',
				baumnr='KB-002',
				raw_qr_value=None,
			)
		).execute()

	assert inserted.data[0]['baumnr'] == 'KB-002'
	assert inserted.data[0]['is_exact_location'] is False


def test_priwa_non_member_cannot_write_kaeferbaum(priwa_project):
	"""Non-members cannot create Käferbaum records in a PRIWA project."""
	non_member_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_client(non_member_token) as client:
		with pytest.raises(Exception):
			client.table('priwa_kaeferbaeume').insert(
				kaeferbaum_payload(priwa_project['id'])
			).execute()


def test_priwa_member_can_confirm_edit_and_merge_befallsgruppen(priwa_project):
	"""Saved groups are authoritative and selected trees can be moved between groups."""
	member_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(member_token) as client:
		first_tree = client.table('priwa_kaeferbaeume').insert(
			kaeferbaum_payload(priwa_project['id'], baumnr='BG-001')
		).execute().data[0]
		second_tree = client.table('priwa_kaeferbaeume').insert(
			kaeferbaum_payload(
				priwa_project['id'],
				geom=priwa_point(lon=8.2046),
				baumnr='BG-002',
				name='Different Observer',
			)
		).execute().data[0]

		first_group_id = client.rpc(
			'priwa_save_befallsgruppe',
			{
				'p_project_id': priwa_project['id'],
				'p_name': 'Suggested group',
				'p_tree_ids': [first_tree['id']],
				'p_dataset_ids': [],
				'p_origin': 'suggestion',
				'p_confidence': 0.82,
				'p_suggestion_reason': 'Nearby trees and dates',
				'p_algorithm_version': 'location-date-v1',
			},
		).execute().data
		second_group_id = client.rpc(
			'priwa_save_befallsgruppe',
			{
				'p_project_id': priwa_project['id'],
				'p_name': 'Manual group',
				'p_tree_ids': [second_tree['id']],
				'p_dataset_ids': [],
				'p_origin': 'manual',
			},
		).execute().data

		client.rpc(
			'priwa_save_befallsgruppe',
			{
				'p_project_id': priwa_project['id'],
				'p_group_id': first_group_id,
				'p_name': 'Merged confirmed group',
				'p_tree_ids': [first_tree['id'], second_tree['id']],
				'p_dataset_ids': [],
				'p_origin': 'suggestion',
				'p_confidence': 0.82,
				'p_suggestion_reason': 'User-reviewed suggestion',
				'p_algorithm_version': 'location-date-v1',
			},
		).execute()

		groups = client.table('priwa_befallsgruppen').select('*').eq(
			'project_id', priwa_project['id']
		).execute()
		members = client.table('priwa_befallsgruppe_members').select('*').eq(
			'group_id', first_group_id
		).execute()
		flights = client.table('priwa_befallsgruppe_flights').select('*').eq(
			'group_id', first_group_id
		).execute()

	assert len(groups.data) == 1
	assert groups.data[0]['id'] == first_group_id
	assert groups.data[0]['name'] == 'Merged confirmed group'
	assert groups.data[0]['created_by'] == priwa_project['member_id']
	assert groups.data[0]['updated_by'] == priwa_project['member_id']
	assert {member['tree_id'] for member in members.data} == {
		first_tree['id'],
		second_tree['id'],
	}
	assert flights.data == []
	assert second_group_id not in {group['id'] for group in groups.data}

	with use_client(member_token) as client:
		with pytest.raises(Exception):
			client.table('priwa_befallsgruppe_members').delete().eq(
				'group_id', first_group_id
			).execute()
		remaining_members = client.table('priwa_befallsgruppe_members').select('*').eq(
			'group_id', first_group_id
		).execute()

	assert len(remaining_members.data) == 2


def test_priwa_soft_delete_removes_tree_from_befallsgruppe(priwa_project):
	"""Soft-deleted trees leave groups, and groups disappear when their last tree is deleted."""
	member_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(member_token) as client:
		first_tree = client.table('priwa_kaeferbaeume').insert(
			kaeferbaum_payload(priwa_project['id'], baumnr='BG-DELETE-1')
		).execute().data[0]
		second_tree = client.table('priwa_kaeferbaeume').insert(
			kaeferbaum_payload(
				priwa_project['id'],
				geom=priwa_point(lon=8.2046),
				baumnr='BG-DELETE-2',
			)
		).execute().data[0]
		group_id = client.rpc(
			'priwa_save_befallsgruppe',
			{
				'p_project_id': priwa_project['id'],
				'p_name': 'Deletion cleanup',
				'p_tree_ids': [first_tree['id'], second_tree['id']],
				'p_dataset_ids': [],
			},
		).execute().data

		client.table('priwa_kaeferbaeume').update(
			{'deleted_at': datetime.now(timezone.utc).isoformat()}
		).eq('id', first_tree['id']).execute()
		remaining_members = client.table('priwa_befallsgruppe_members').select(
			'tree_id'
		).eq('group_id', group_id).execute()
		remaining_group = client.table('priwa_befallsgruppen').select('id').eq(
			'id', group_id
		).execute()

	assert remaining_members.data == [{'tree_id': second_tree['id']}]
	assert remaining_group.data == [{'id': group_id}]

	with use_client(member_token) as client:
		client.table('priwa_kaeferbaeume').update(
			{'deleted_at': datetime.now(timezone.utc).isoformat()}
		).eq('id', second_tree['id']).execute()
		deleted_group = client.table('priwa_befallsgruppen').select('id').eq(
			'id', group_id
		).execute()

	assert deleted_group.data == []


def test_priwa_befallsgruppen_are_hidden_and_not_writable_for_non_members(priwa_project):
	"""Befallsgruppe tables and save RPC inherit PRIWA project membership boundaries."""
	member_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)
	non_member_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_client(member_token) as client:
		tree = client.table('priwa_kaeferbaeume').insert(
			kaeferbaum_payload(priwa_project['id'], baumnr='BG-RLS')
		).execute().data[0]
		group_id = client.rpc(
			'priwa_save_befallsgruppe',
			{
				'p_project_id': priwa_project['id'],
				'p_name': 'Protected group',
				'p_tree_ids': [tree['id']],
				'p_dataset_ids': [],
			},
		).execute().data

	with use_client(non_member_token) as client:
		assert client.table('priwa_befallsgruppen').select('*').eq('id', group_id).execute().data == []
		assert client.table('priwa_befallsgruppe_members').select('*').eq(
			'group_id', group_id
		).execute().data == []
		with pytest.raises(Exception):
			client.rpc(
				'priwa_save_befallsgruppe',
				{
					'p_project_id': priwa_project['id'],
					'p_name': 'Forbidden group',
					'p_tree_ids': [tree['id']],
					'p_dataset_ids': [],
				},
			).execute()

	with use_client(member_token) as client:
		with pytest.raises(Exception):
			client.table('priwa_befallsgruppe_flights').insert(
				{
					'group_id': group_id,
					'dataset_id': 91001,
					'source': 'manual',
					'created_by': priwa_project['member_id'],
				}
			).execute()
