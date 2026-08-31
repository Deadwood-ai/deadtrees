from datetime import datetime, timezone
import threading
import uuid

import psycopg
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


def create_processed_priwa_flight(client, user_id, file_stem):
	"""Create one eligible processed drone COG and return its dataset ID."""
	dataset = client.table(settings.datasets_table).insert(
		{
			'user_id': user_id,
			'file_name': f'{file_stem}.tif',
			'license': 'CC BY',
			'platform': 'drone',
			'authors': ['PRIWA Test'],
			'data_access': 'public',
			'aquisition_year': 2026,
			'aquisition_month': 7,
			'aquisition_day': 30,
			'archived': False,
		}
	).execute().data[0]
	dataset_id = dataset['id']
	client.table('v2_statuses').insert(
		{
			'dataset_id': dataset_id,
			'current_status': 'idle',
			'is_upload_done': True,
			'is_ortho_done': True,
			'is_cog_done': True,
			'has_error': False,
		}
	).execute()
	client.table('v2_orthos').insert(
		{
			'dataset_id': dataset_id,
			'ortho_file_name': f'{file_stem}.tif',
			'version': 1,
			'sha256': f'{file_stem}-{dataset_id}',
			'bbox': 'BOX(8.20 48.40,8.21 48.41)',
			'ortho_upload_runtime': 0.1,
			'ortho_file_size': 1,
			'ortho_info': {},
		}
	).execute()
	client.table('v2_cogs').insert(
		{
			'dataset_id': dataset_id,
			'cog_file_name': f'{file_stem}-cog.tif',
			'version': 1,
			'cog_info': {},
			'cog_processing_runtime': 0.1,
			'cog_path': f'qa/cogs/{file_stem}-{dataset_id}.tif',
			'cog_file_size': 1,
		}
	).execute()
	return dataset_id


def authenticated_db_connection(user_id):
	"""Open a transaction-scoped authenticated DB session for concurrency tests."""
	connection = psycopg.connect(settings.SUPABASE_DB_URL)
	with connection.cursor() as cursor:
		cursor.execute('set role authenticated')
		cursor.execute(
			"select set_config('request.jwt.claim.sub', %s, false)",
			(str(user_id),),
		)
		cursor.execute(
			"select set_config('request.jwt.claim.role', 'authenticated', false)"
		)
	return connection


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


@pytest.fixture(scope='function')
def priwa_flight_dataset(test_user):
	"""Create one public processed drone COG owned by the PRIWA test member."""
	with use_service_client() as client:
		dataset_id = create_processed_priwa_flight(
			client,
			test_user,
			'priwa-flight-review',
		)

	try:
		yield dataset_id
	finally:
		with use_service_client() as client:
			client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


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
			.update(
				{
					'deleted_at': None,
					'deleted_by': None,
					'fund': 'should-not-change',
					'client_updated_at': datetime.now(timezone.utc).isoformat(),
				}
			)
			.eq('id', created['id'])
			.execute()
		)

	assert delete_attempt.data == []
	assert len(after_delete_attempt.data) == 1
	assert len(member_records_after_soft_delete.data) == 1
	assert member_records_after_soft_delete.data[0]['deleted_at'] is not None
	assert len(blocked_update.data) == 1
	assert blocked_update.data[0]['deleted_at'] is not None
	assert blocked_update.data[0]['fund'] == 'kontrolliert'

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


def test_priwa_member_can_classify_a_project_flight(priwa_project, priwa_flight_dataset):
	"""Project members can explicitly classify eligible COGs for PRIWA review."""
	member_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)
	non_member_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_client(member_token) as client:
		client.rpc(
			'priwa_set_project_flight_type',
			{
				'p_project_id': priwa_project['id'],
				'p_dataset_id': priwa_flight_dataset,
				'p_flight_type': 'umfeldbefliegung',
			},
		).execute()
		flights = client.rpc(
			'priwa_project_latest_flight_mosaics',
			{
				'p_project_id': priwa_project['id'],
				'p_limit': 100,
				'p_offset': 0,
			},
		).execute()

	classified = next(flight for flight in flights.data if flight['id'] == str(priwa_flight_dataset))
	assert classified['flight_type'] == 'umfeldbefliegung'

	with use_client(non_member_token) as client:
		visible_classifications = client.table('priwa_project_flights').select(
			'flight_type'
		).eq('project_id', priwa_project['id']).execute()
		with pytest.raises(Exception):
			client.rpc(
				'priwa_set_project_flight_type',
				{
					'p_project_id': priwa_project['id'],
					'p_dataset_id': priwa_flight_dataset,
					'p_flight_type': 'not_priwa',
				},
			).execute()

	assert visible_classifications.data == []

	with use_client(member_token) as client:
		client.rpc(
			'priwa_set_project_flight_type',
			{
				'p_project_id': priwa_project['id'],
				'p_dataset_id': priwa_flight_dataset,
				'p_flight_type': None,
			},
		).execute()
		reset_classifications = client.table('priwa_project_flights').select(
			'flight_type'
		).eq('project_id', priwa_project['id']).eq(
			'dataset_id', priwa_flight_dataset
		).execute()

	assert reset_classifications.data == []


def test_priwa_group_assignment_confirms_flight_and_prevents_exclusion(
	priwa_project, priwa_flight_dataset
):
	"""A confirmed group assignment is authoritative and cannot be excluded."""
	member_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(member_token) as client:
		tree = client.table('priwa_kaeferbaeume').insert(
			kaeferbaum_payload(priwa_project['id'], baumnr='BG-FLIGHT')
		).execute().data[0]
		client.rpc(
			'priwa_save_befallsgruppe',
			{
				'p_project_id': priwa_project['id'],
				'p_name': 'Flight-confirmed group',
				'p_tree_ids': [tree['id']],
				'p_dataset_ids': [priwa_flight_dataset],
				'p_origin': 'manual',
			},
		).execute()
		classification = client.table('priwa_project_flights').select(
			'flight_type'
		).eq('project_id', priwa_project['id']).eq(
			'dataset_id', priwa_flight_dataset
		).single().execute()

		assert classification.data['flight_type'] == 'umfeldbefliegung'
		with pytest.raises(Exception):
			client.rpc(
				'priwa_set_project_flight_type',
				{
					'p_project_id': priwa_project['id'],
					'p_dataset_id': priwa_flight_dataset,
					'p_flight_type': 'not_priwa',
				},
			).execute()
		with pytest.raises(Exception):
			client.rpc(
				'priwa_set_project_flight_type',
				{
					'p_project_id': priwa_project['id'],
					'p_dataset_id': priwa_flight_dataset,
					'p_flight_type': None,
				},
			).execute()
		with pytest.raises(Exception):
			client.table('priwa_project_flights').delete().eq(
				'project_id', priwa_project['id']
			).eq('dataset_id', priwa_flight_dataset).execute()


def test_priwa_classification_and_assignment_serialize_across_sessions(
	priwa_project, priwa_flight_dataset
):
	"""Concurrent classification and assignment cannot commit conflicting states."""
	member_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(member_token) as client:
		tree = client.table('priwa_kaeferbaeume').insert(
			kaeferbaum_payload(priwa_project['id'], baumnr='BG-RACE')
		).execute().data[0]
		group_id = client.rpc(
			'priwa_save_befallsgruppe',
			{
				'p_project_id': priwa_project['id'],
				'p_name': 'Concurrent flight group',
				'p_tree_ids': [tree['id']],
				'p_dataset_ids': [],
				'p_origin': 'manual',
			},
		).execute().data

	classification_connection = authenticated_db_connection(
		priwa_project['member_id']
	)
	assignment_connection = authenticated_db_connection(priwa_project['member_id'])
	assignment_finished = threading.Event()
	assignment_errors = []

	def assign_flight():
		try:
			with assignment_connection.cursor() as cursor:
				cursor.execute(
					'select public.priwa_add_flight_to_befallsgruppe(%s, %s, %s)',
					(priwa_project['id'], group_id, priwa_flight_dataset),
				)
			assignment_connection.commit()
		except Exception as error:
			assignment_connection.rollback()
			assignment_errors.append(error)
		finally:
			assignment_finished.set()

	try:
		with classification_connection.cursor() as cursor:
			cursor.execute(
				'select public.priwa_set_project_flight_type(%s, %s, %s)',
				(
					priwa_project['id'],
					priwa_flight_dataset,
					'not_priwa',
				),
			)

		assignment_thread = threading.Thread(target=assign_flight)
		assignment_thread.start()
		assert not assignment_finished.wait(0.25)

		classification_connection.commit()
		assignment_thread.join(timeout=5)
		assert assignment_finished.is_set()
	finally:
		classification_connection.close()
		assignment_connection.close()

	assert len(assignment_errors) == 1
	assert 'excluded flight' in str(assignment_errors[0]).lower()

	with use_client(member_token) as client:
		classification = client.table('priwa_project_flights').select(
			'flight_type'
		).eq('project_id', priwa_project['id']).eq(
			'dataset_id', priwa_flight_dataset
		).single().execute()
		assignments = client.table('priwa_befallsgruppe_flights').select(
			'dataset_id'
		).eq('group_id', group_id).execute()

	assert classification.data['flight_type'] == 'not_priwa'
	assert assignments.data == []


def test_priwa_actorless_backfill_preserves_historical_review_timestamp(
	priwa_project, priwa_flight_dataset
):
	"""Migration-style service writes retain the assignment's original timestamp."""
	historical_reviewed_at = datetime(2026, 1, 15, 8, 30, tzinfo=timezone.utc)

	with use_service_client() as client:
		classification = client.table('priwa_project_flights').insert(
			{
				'project_id': priwa_project['id'],
				'dataset_id': priwa_flight_dataset,
				'flight_type': 'umfeldbefliegung',
				'reviewed_by': priwa_project['member_id'],
				'reviewed_at': historical_reviewed_at.isoformat(),
			}
		).execute().data[0]

	assert datetime.fromisoformat(classification['reviewed_at']) == historical_reviewed_at


def test_priwa_member_can_atomically_assign_teammate_flight(
	priwa_project, test_user2
):
	"""Eligibility must include COGs uploaded by a different project member."""
	member_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)
	dataset_id = None

	try:
		with use_service_client() as client:
			client.table('priwa_project_memberships').insert(
				{
					'project_id': priwa_project['id'],
					'user_id': test_user2,
					'role': 'field_user',
				}
			).execute()
			dataset_id = create_processed_priwa_flight(
				client,
				test_user2,
				'priwa-teammate-flight',
			)

		with use_client(member_token) as client:
			flights = client.rpc(
				'priwa_project_latest_flight_mosaics',
				{
					'p_project_id': priwa_project['id'],
					'p_limit': 100,
					'p_offset': 0,
				},
			).execute()
			assert str(dataset_id) in {flight['id'] for flight in flights.data}

			tree = client.table('priwa_kaeferbaeume').insert(
				kaeferbaum_payload(priwa_project['id'], baumnr='BG-TEAMMATE')
			).execute().data[0]
			group_id = client.rpc(
				'priwa_save_befallsgruppe',
				{
					'p_project_id': priwa_project['id'],
					'p_name': 'Teammate flight group',
					'p_tree_ids': [tree['id']],
					'p_dataset_ids': [],
					'p_origin': 'manual',
				},
			).execute().data
			for _ in range(2):
				client.rpc(
					'priwa_add_flight_to_befallsgruppe',
					{
						'p_project_id': priwa_project['id'],
						'p_group_id': group_id,
						'p_dataset_id': dataset_id,
					},
				).execute()

			assignments = client.table('priwa_befallsgruppe_flights').select(
				'dataset_id'
			).eq('group_id', group_id).execute()
			classification = client.table('priwa_project_flights').select(
				'flight_type'
			).eq('project_id', priwa_project['id']).eq(
				'dataset_id', dataset_id
			).single().execute()

		assert assignments.data == [{'dataset_id': dataset_id}]
		assert classification.data['flight_type'] == 'umfeldbefliegung'
	finally:
		if dataset_id is not None:
			with use_service_client() as client:
				client.table(settings.datasets_table).delete().eq(
					'id', dataset_id
				).execute()


def test_priwa_group_assignment_accepts_flight_after_first_catalog_page(
	priwa_project, test_user
):
	"""Befallsgruppe validation must not reject eligible flights beyond the first 100."""
	member_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)
	dataset_ids = []

	try:
		with use_service_client() as client:
			datasets = client.table(settings.datasets_table).insert(
				[
					{
						'user_id': test_user,
						'file_name': f'priwa-page-{index:03d}.tif',
						'license': 'CC BY',
						'platform': 'drone',
						'authors': ['PRIWA Pagination Test'],
						'data_access': 'public',
						'aquisition_year': 2026,
						'aquisition_month': 7,
						'aquisition_day': 30,
						'archived': False,
					}
					for index in range(101)
				]
			).execute().data
			dataset_ids = [dataset['id'] for dataset in datasets]
			client.table('v2_statuses').insert(
				[
					{
						'dataset_id': dataset_id,
						'current_status': 'idle',
						'is_upload_done': True,
						'is_ortho_done': True,
						'is_cog_done': True,
						'has_error': False,
					}
					for dataset_id in dataset_ids
				]
			).execute()
			client.table('v2_orthos').insert(
				[
					{
						'dataset_id': dataset_id,
						'ortho_file_name': f'priwa-page-{dataset_id}.tif',
						'version': 1,
						'sha256': f'priwa-page-{dataset_id}',
						'bbox': 'BOX(8.20 48.40,8.21 48.41)',
						'ortho_upload_runtime': 0.1,
						'ortho_file_size': 1,
						'ortho_info': {},
					}
					for dataset_id in dataset_ids
				]
			).execute()
			client.table('v2_cogs').insert(
				[
					{
						'dataset_id': dataset_id,
						'cog_file_name': f'priwa-page-{dataset_id}-cog.tif',
						'version': 1,
						'cog_info': {},
						'cog_processing_runtime': 0.1,
						'cog_path': f'qa/cogs/priwa-page-{dataset_id}.tif',
						'cog_file_size': 1,
					}
					for dataset_id in dataset_ids
				]
			).execute()

		target_dataset_id = dataset_ids[0]
		with use_client(member_token) as client:
			first_page = client.rpc(
				'priwa_project_latest_flight_mosaics',
				{
					'p_project_id': priwa_project['id'],
					'p_limit': 100,
					'p_offset': 0,
				},
			).execute()
			assert str(target_dataset_id) not in {flight['id'] for flight in first_page.data}

			tree = client.table('priwa_kaeferbaeume').insert(
				kaeferbaum_payload(priwa_project['id'], baumnr='BG-PAGE-101')
			).execute().data[0]
			client.rpc(
				'priwa_save_befallsgruppe',
				{
					'p_project_id': priwa_project['id'],
					'p_name': 'Flight beyond first page',
					'p_tree_ids': [tree['id']],
					'p_dataset_ids': [target_dataset_id],
					'p_origin': 'manual',
				},
			).execute()
			classification = client.table('priwa_project_flights').select(
				'flight_type'
			).eq('project_id', priwa_project['id']).eq(
				'dataset_id', target_dataset_id
			).single().execute()

		assert classification.data['flight_type'] == 'umfeldbefliegung'
	finally:
		if dataset_ids:
			with use_service_client() as client:
				client.table(settings.datasets_table).delete().in_('id', dataset_ids).execute()


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
