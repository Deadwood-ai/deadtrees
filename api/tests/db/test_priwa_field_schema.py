from datetime import datetime, timezone
import uuid

import pytest

from shared.db import login, use_client, use_service_client
from shared.settings import settings


def priwa_point(lon=8.2044, lat=48.4064):
	return {'type': 'Point', 'coordinates': [lon, lat]}


def kaeferbaum_payload(project_id, **overrides):
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
			client.table('priwa_kaeferbaeume').delete().eq('project_id', project_id).execute()
			client.table('priwa_project_memberships').delete().eq('project_id', project_id).execute()
			client.table('priwa_projects').delete().eq('id', project_id).execute()


def test_priwa_membership_gates_projects_and_kaeferbaeume(priwa_project, test_user):
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
		with pytest.raises(Exception):
			client.table('priwa_kaeferbaeume').delete().eq('id', created['id']).execute()

		client.table('priwa_kaeferbaeume').update(
			{'deleted_at': datetime.now(timezone.utc).isoformat()}
		).eq('id', created['id']).execute()
		active_records = client.table('priwa_kaeferbaeume').select('*').eq('id', created['id']).execute()

	assert active_records.data == []


def test_priwa_kaeferbaum_requires_baumnr_for_estimated_locations(priwa_project):
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
	non_member_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_client(non_member_token) as client:
		with pytest.raises(Exception):
			client.table('priwa_kaeferbaeume').insert(
				kaeferbaum_payload(priwa_project['id'])
			).execute()
