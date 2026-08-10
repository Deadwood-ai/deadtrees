import hashlib
import uuid

import pytest
from shapely.geometry import Polygon

from shared.db import login, use_client, use_service_client
from shared.settings import settings


def polygon_payload(fid: int, probability: str, x_offset: int = 0):
	geometry = Polygon(
		[
			(450000 + x_offset, 5360000),
			(450010 + x_offset, 5360000),
			(450010 + x_offset, 5360010),
			(450000 + x_offset, 5360010),
			(450000 + x_offset, 5360000),
		]
	)
	return {'fid': fid, 'probability': probability, 'wkb_hex': geometry.wkb_hex}


def checksum(label: str) -> str:
	return hashlib.sha256(label.encode('utf-8')).hexdigest()


@pytest.fixture
def warnkarte_project(test_user, test_user2):
	project_id = str(uuid.uuid4())
	with use_service_client() as client:
		client.table('priwa_projects').insert(
			{'id': project_id, 'slug': f'warnkarte-{project_id}', 'name': 'Warnkarte Test'}
		).execute()
		client.table('priwa_project_memberships').insert(
			[
				{'project_id': project_id, 'user_id': test_user, 'role': 'admin'},
				{'project_id': project_id, 'user_id': test_user2, 'role': 'field_user'},
			]
		).execute()

	try:
		yield {'id': project_id, 'admin_id': test_user, 'member_id': test_user2}
	finally:
		with use_service_client() as client:
			client.table('priwa_warnkarte_publications').delete().eq('project_id', project_id).execute()
			client.table('priwa_warnkarte_archive_events').delete().eq('project_id', project_id).execute()
			client.table('priwa_warnkarte_versions').delete().eq('project_id', project_id).execute()
			client.table('priwa_project_memberships').delete().eq('project_id', project_id).execute()
			client.table('priwa_projects').delete().eq('id', project_id).execute()


def import_version(client, actor_id: str, project_id: str, label: str, source_date: str, polygons=None):
	return (
		client.rpc(
			'priwa_import_warnkarte',
			{
				'p_actor': actor_id,
				'p_project_id': project_id,
				'p_source_filename': f'warnkarte_{source_date}.gpkg',
				'p_checksum_sha256': checksum(label),
				'p_source_date': source_date,
				'p_source_layer': 'warning_polygons',
				'p_source_crs': 'EPSG:32632',
				'p_polygons': polygons or [polygon_payload(1, '0.6000000238')],
			},
		)
		.execute()
		.data
	)


def test_admin_import_is_normalized_and_member_cannot_read_provenance(warnkarte_project):
	admin_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)
	member_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_service_client() as client:
		version_id = import_version(
			client,
			warnkarte_project['admin_id'],
			warnkarte_project['id'],
			'normalized',
			'2024-06-25',
		)

	with use_client(admin_token) as client:
		version_rows = client.table('priwa_warnkarte_versions').select('*').eq('id', version_id).execute().data
		polygon_rows = client.table('priwa_warnkarte_polygons').select('*').eq('version_id', version_id).execute().data

	assert version_rows[0]['feature_count'] == 1
	assert version_rows[0]['source_filename'] == 'warnkarte_2024-06-25.gpkg'
	assert float(polygon_rows[0]['probability']) == 0.6

	with use_client(member_token) as client:
		assert client.table('priwa_warnkarte_versions').select('*').eq('id', version_id).execute().data == []
		assert client.table('priwa_warnkarte_polygons').select('*').eq('version_id', version_id).execute().data == []


def test_import_rpc_is_server_only_and_rechecks_actor_admin_role(warnkarte_project):
	admin_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)
	member_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_client(admin_token) as client:
		with pytest.raises(Exception):
			import_version(
				client,
				warnkarte_project['admin_id'],
				warnkarte_project['id'],
				'direct-browser-call',
				'2024-06-24',
			)

	with use_client(member_token) as client:
		with pytest.raises(Exception):
			client.rpc('priwa_import_warnkarte', {}).execute()

	with use_service_client() as client:
		with pytest.raises(Exception, match='admin access is required'):
			import_version(
				client,
				warnkarte_project['member_id'],
				warnkarte_project['id'],
				'forbidden',
				'2024-06-25',
			)

	with use_service_client() as client:
		rows = (
			client.table('priwa_warnkarte_versions')
			.select('id')
			.eq('project_id', warnkarte_project['id'])
			.eq('checksum_sha256', checksum('forbidden'))
			.execute()
		).data
	assert rows == []


def test_duplicate_checksum_and_polygon_failure_are_atomic(warnkarte_project):
	with use_service_client() as client:
		import_version(client, warnkarte_project['admin_id'], warnkarte_project['id'], 'duplicate', '2024-06-25')
		with pytest.raises(Exception):
			import_version(
				client,
				warnkarte_project['admin_id'],
				warnkarte_project['id'],
				'duplicate',
				'2024-06-25',
			)
		with pytest.raises(Exception):
			import_version(
				client,
				warnkarte_project['admin_id'],
				warnkarte_project['id'],
				'atomic-failure',
				'2024-06-26',
				[
					polygon_payload(1, '0.2'),
					polygon_payload(1, '0.3', x_offset=20),
				],
			)
		with pytest.raises(Exception, match='0.1 steps'):
			import_version(
				client,
				warnkarte_project['admin_id'],
				warnkarte_project['id'],
				'invalid-probability',
				'2024-06-27',
				[polygon_payload(3, '0.65')],
			)

	with use_service_client() as client:
		failed_versions = (
			client.table('priwa_warnkarte_versions')
			.select('id')
			.eq('project_id', warnkarte_project['id'])
			.eq('checksum_sha256', checksum('atomic-failure'))
			.execute()
		).data
	assert failed_versions == []
	with use_service_client() as client:
		invalid_probability_versions = (
			client.table('priwa_warnkarte_versions')
			.select('id')
			.eq('project_id', warnkarte_project['id'])
			.eq('checksum_sha256', checksum('invalid-probability'))
			.execute()
		).data
	assert invalid_probability_versions == []


def test_publication_and_reversion_use_latest_append_only_record(warnkarte_project):
	admin_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)
	member_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)
	large_overlay_polygons = [polygon_payload(fid, '0.9', x_offset=fid * 20) for fid in range(1, 1002)]

	with use_service_client() as client:
		old_version_id = import_version(
			client,
			warnkarte_project['admin_id'],
			warnkarte_project['id'],
			'old',
			'2024-06-25',
		)
		new_version_id = import_version(
			client,
			warnkarte_project['admin_id'],
			warnkarte_project['id'],
			'new',
			'2024-07-01',
			large_overlay_polygons,
		)

	with use_client(admin_token) as client:
		preview = (
			client.rpc(
				'priwa_warnkarte_version_overlay',
				{'p_project_id': warnkarte_project['id'], 'p_version_id': new_version_id},
			)
			.execute()
			.data
		)
		assert len(preview) == 1
		assert len(preview[0]['payload']['features']) == 1001

		client.rpc('priwa_publish_warnkarte', {'p_version_id': old_version_id}).execute()
		client.rpc('priwa_publish_warnkarte', {'p_version_id': new_version_id}).execute()

	with use_client(member_token) as client:
		large_active = client.rpc('priwa_current_warnkarte', {'p_project_id': warnkarte_project['id']}).execute().data

	assert len(large_active) == 1
	assert len(large_active[0]['payload']['features']) == 1001
	assert large_active[0]['payload']['version_id'] is None
	assert large_active[0]['payload']['source_date'] == '2024-07-01'
	assert set(large_active[0]['payload']) == {'version_id', 'source_date', 'type', 'features'}
	assert set(large_active[0]['payload']['features'][0]) == {'type', 'geometry', 'properties'}
	assert set(large_active[0]['payload']['features'][0]['properties']) == {'probability'}

	with use_client(admin_token) as client:
		client.rpc('priwa_publish_warnkarte', {'p_version_id': old_version_id}).execute()

	with use_client(member_token) as client:
		active = client.rpc('priwa_current_warnkarte', {'p_project_id': warnkarte_project['id']}).execute().data

	assert len(active) == 1
	assert active[0]['payload']['source_date'] == '2024-06-25'
	assert len(active[0]['payload']['features']) == 1

	with use_service_client() as client:
		publications = (
			client.table('priwa_warnkarte_publications')
			.select('version_id')
			.eq('project_id', warnkarte_project['id'])
			.order('id')
			.execute()
		).data
	assert [row['version_id'] for row in publications] == [old_version_id, new_version_id, old_version_id]


def test_archiving_is_reversible_admin_only_and_cannot_hide_current_version(warnkarte_project):
	admin_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)
	member_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_service_client() as client:
		current_version_id = import_version(
			client,
			warnkarte_project['admin_id'],
			warnkarte_project['id'],
			'current-for-archive',
			'2024-07-01',
		)
		older_version_id = import_version(
			client,
			warnkarte_project['admin_id'],
			warnkarte_project['id'],
			'older-for-archive',
			'2024-06-25',
		)

	with use_client(admin_token) as client:
		client.rpc('priwa_publish_warnkarte', {'p_version_id': current_version_id}).execute()
		with pytest.raises(Exception, match='current version cannot be archived'):
			client.rpc('priwa_archive_warnkarte', {'p_version_id': current_version_id}).execute()

	with use_client(member_token) as client:
		with pytest.raises(Exception, match='admin access is required'):
			client.rpc('priwa_archive_warnkarte', {'p_version_id': older_version_id}).execute()

	with use_client(admin_token) as client:
		first_event_id = client.rpc('priwa_archive_warnkarte', {'p_version_id': older_version_id}).execute().data
		second_event_id = client.rpc('priwa_archive_warnkarte', {'p_version_id': older_version_id}).execute().data
		assert second_event_id == first_event_id

		archive_state = (
			client.table('priwa_warnkarte_archive_states')
			.select('is_archived')
			.eq('version_id', older_version_id)
			.single()
			.execute()
		).data
		assert archive_state == {'is_archived': True}

		archived_overlay = (
			client.rpc(
				'priwa_warnkarte_version_overlay',
				{'p_project_id': warnkarte_project['id'], 'p_version_id': older_version_id},
			)
			.execute()
			.data
		)
		assert archived_overlay == []

		with pytest.raises(Exception, match='archived version cannot be published'):
			client.rpc('priwa_publish_warnkarte', {'p_version_id': older_version_id}).execute()

	with use_client(member_token) as client:
		assert (
			client.table('priwa_warnkarte_archive_events')
			.select('*')
			.eq('project_id', warnkarte_project['id'])
			.execute()
			.data
			== []
		)
		assert (
			client.table('priwa_warnkarte_archive_states')
			.select('*')
			.eq('project_id', warnkarte_project['id'])
			.execute()
			.data
			== []
		)

	with use_client(admin_token) as client:
		client.rpc('priwa_restore_warnkarte', {'p_version_id': older_version_id}).execute()
		restored_overlay = (
			client.rpc(
				'priwa_warnkarte_version_overlay',
				{'p_project_id': warnkarte_project['id'], 'p_version_id': older_version_id},
			)
			.execute()
			.data
		)
		assert len(restored_overlay[0]['payload']['features']) == 1
		client.rpc('priwa_publish_warnkarte', {'p_version_id': older_version_id}).execute()

	with use_service_client() as client:
		events = (
			client.table('priwa_warnkarte_archive_events')
			.select('action')
			.eq('version_id', older_version_id)
			.order('id')
			.execute()
		).data
	assert [event['action'] for event in events] == ['archive', 'restore']
