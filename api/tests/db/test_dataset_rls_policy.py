import pytest
from shared.db import use_anon_client, use_client, use_service_client, login
from shared.settings import settings
from shared.models import (
	DatasetAccessEnum,
	LabelDataEnum,
	LabelSourceEnum,
	LabelTypeEnum,
	LicenseEnum,
	PlatformEnum,
	StatusEnum,
)
from shared.testing.fixtures import test_processor_user


@pytest.fixture(scope='function')
def setup_processor_privileges(auth_token, test_processor_user):
	"""Ensure processor user has the necessary privileges in the privileged_users table"""
	privileged_user_id = None

	try:
		# Get processor token for operations
		processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)

		with use_client(processor_token) as processor_client:
			# Check if processor already exists in privileged_users
			existing = (
				processor_client.table('privileged_users').select('*').eq('user_id', test_processor_user).execute()
			)

			if not existing.data:
				# Add processor to privileged users with all permissions
				processor_entry = {
					'user_id': test_processor_user,
					'can_upload_private': True,
					'can_view_all_private': True,
					'can_audit': True,
				}
				response = processor_client.table('privileged_users').insert(processor_entry).execute()
				if response.data:
					privileged_user_id = response.data[0]['id']
			else:
				# Update existing entry to ensure can_view_all_private is true
				processor_client.table('privileged_users').update(
					{
						'can_upload_private': True,
						'can_view_all_private': True,
						'can_audit': True,
					}
				).eq('user_id', test_processor_user).execute()

		yield test_processor_user

	finally:
		# Clean up only if we created a new entry
		if privileged_user_id:
			try:
				with use_client(processor_token) as client:
					client.table('privileged_users').delete().eq('id', privileged_user_id).execute()
			except Exception as e:
				print(f'Failed to clean up processor privileges: {str(e)}')


@pytest.fixture(scope='function')
def datasets_with_mixed_access(auth_token, test_user, test_processor_user):
	"""Create test datasets with different access levels"""
	datasets = []

	try:
		with use_client(auth_token) as supabase_client:
			# Create a public dataset
			public_dataset = {
				'file_name': 'test-public-dataset.tif',
				'user_id': test_user,
				'license': LicenseEnum.cc_by,
				'platform': PlatformEnum.drone,
				'authors': ['Test Author'],
				'data_access': DatasetAccessEnum.public,
				'aquisition_year': 2024,
				'aquisition_month': 1,
				'aquisition_day': 1,
			}
			response = supabase_client.table(settings.datasets_table).insert(public_dataset).execute()
			public_dataset_id = response.data[0]['id']
			datasets.append(public_dataset_id)

			# Create a private dataset
			private_dataset = {
				'file_name': 'test-private-dataset.tif',
				'user_id': test_user,
				'license': LicenseEnum.cc_by,
				'platform': PlatformEnum.drone,
				'authors': ['Test Author'],
				'data_access': DatasetAccessEnum.private,
				'aquisition_year': 2024,
				'aquisition_month': 1,
				'aquisition_day': 1,
			}
			response = supabase_client.table(settings.datasets_table).insert(private_dataset).execute()
			private_dataset_id = response.data[0]['id']
			datasets.append(private_dataset_id)

		yield {'public_id': public_dataset_id, 'private_id': private_dataset_id, 'owner_id': test_user}

	finally:
		# Clean up datasets
		with use_client(auth_token) as supabase_client:
			for dataset_id in datasets:
				supabase_client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


@pytest.fixture(scope='function')
def archive_ready_private_dataset(test_user):
	"""Create a private dataset that satisfies public_dataset_archive_items predicates."""
	dataset_id = None

	try:
		with use_service_client() as client:
			dataset = {
				'file_name': 'test-private-archive-visible.tif',
				'user_id': test_user,
				'license': LicenseEnum.cc_by.value,
				'platform': PlatformEnum.drone.value,
				'authors': ['Private Archive Test Author'],
				'data_access': DatasetAccessEnum.private.value,
				'aquisition_year': 2024,
				'aquisition_month': 1,
				'aquisition_day': 1,
			}
			response = client.table(settings.datasets_table).insert(dataset).execute()
			dataset_id = response.data[0]['id']

			client.table(settings.orthos_table).insert(
				{
					'dataset_id': dataset_id,
					'ortho_file_name': 'test-private-archive-visible.tif',
					'version': 1,
					'ortho_file_size': 1,
					'bbox': 'BOX(13.4050 52.5200,13.4150 52.5300)',
					'sha256': 'test-private-archive-visible',
					'ortho_upload_runtime': 0.1,
				}
			).execute()
			client.table(settings.thumbnails_table).insert(
				{
					'dataset_id': dataset_id,
					'thumbnail_file_name': 'test-private-archive-visible.jpg',
					'thumbnail_path': 'test-private-archive-visible.jpg',
					'thumbnail_file_size': 1,
					'version': 1,
				}
			).execute()
			client.table(settings.metadata_table).insert(
				{
					'dataset_id': dataset_id,
					'metadata': {
						'gadm': {
							'admin_level_1': 'DEU',
							'admin_level_2': 'Berlin',
							'admin_level_3': 'Berlin',
						},
						'biome': {
							'biome_name': 'Temperate Broadleaf and Mixed Forests',
						},
					},
					'version': 1,
					'processing_runtime': 0.1,
				}
			).execute()
			client.table(settings.statuses_table).insert(
				{
					'dataset_id': dataset_id,
					'current_status': StatusEnum.idle.value,
					'is_upload_done': True,
					'is_ortho_done': True,
					'is_cog_done': True,
					'is_thumbnail_done': True,
					'is_deadwood_done': True,
					'is_forest_cover_done': True,
					'is_metadata_done': True,
					'has_error': False,
				}
			).execute()

		yield dataset_id

	finally:
		if dataset_id:
			with use_service_client() as client:
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.metadata_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.thumbnails_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.orthos_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_rls_policy_for_private_datasets(datasets_with_mixed_access, auth_token, setup_processor_privileges):
	"""Test the RLS policy for private datasets"""
	# Get user token - this is the owner of the datasets
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD)

	# Owner should be able to see their own datasets (both public and private)
	with use_client(user_token) as supabase_client:
		# Owner can see public dataset
		response = (
			supabase_client.table(settings.datasets_table)
			.select('*')
			.eq('id', datasets_with_mixed_access['public_id'])
			.execute()
		)
		assert len(response.data) == 1

		# Owner can see private dataset
		response = (
			supabase_client.table(settings.datasets_table)
			.select('*')
			.eq('id', datasets_with_mixed_access['private_id'])
			.execute()
		)
		assert len(response.data) == 1

	# Processor should be able to see all datasets
	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)
	with use_client(processor_token) as supabase_client:
		# Processor can see public dataset
		response = (
			supabase_client.table(settings.datasets_table)
			.select('*')
			.eq('id', datasets_with_mixed_access['public_id'])
			.execute()
		)
		assert len(response.data) == 1

		# Processor can see private dataset
		response = (
			supabase_client.table(settings.datasets_table)
			.select('*')
			.eq('id', datasets_with_mixed_access['private_id'])
			.execute()
		)
		assert len(response.data) == 1

	# Public/anonymous access - create a client without authentication
	with use_anon_client() as public_client:
		# Public can see public dataset
		response = (
			public_client.table(settings.datasets_table)
			.select('*')
			.eq('id', datasets_with_mixed_access['public_id'])
			.execute()
		)
		assert len(response.data) == 1

		# Public cannot see private dataset
		response = (
			public_client.table(settings.datasets_table)
			.select('*')
			.eq('id', datasets_with_mixed_access['private_id'])
			.execute()
		)
		assert len(response.data) == 0


def test_rls_policy_for_view_with_private_datasets(datasets_with_mixed_access, auth_token, setup_processor_privileges):
	"""Test that the RLS policy works correctly with the v2_full_dataset_view"""
	# Get user token - this is the owner of the datasets
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD)

	# Owner should be able to see their own datasets (both public and private) through the view
	with use_client(user_token) as supabase_client:
		# Owner can see public dataset through the view
		response = (
			supabase_client.from_('v2_full_dataset_view')
			.select('*')
			.eq('id', datasets_with_mixed_access['public_id'])
			.execute()
		)
		assert len(response.data) == 1

		# Owner can see private dataset through the view
		response = (
			supabase_client.from_('v2_full_dataset_view')
			.select('*')
			.eq('id', datasets_with_mixed_access['private_id'])
			.execute()
		)
		assert len(response.data) == 1

	# Processor should be able to see all datasets through the view
	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
	with use_client(processor_token) as supabase_client:
		# Processor can see public dataset through the view
		response = (
			supabase_client.from_('v2_full_dataset_view')
			.select('*')
			.eq('id', datasets_with_mixed_access['public_id'])
			.execute()
		)
		assert len(response.data) == 1

		# Processor can see private dataset through the view
		response = (
			supabase_client.from_('v2_full_dataset_view')
			.select('*')
			.eq('id', datasets_with_mixed_access['private_id'])
			.execute()
		)
		assert len(response.data) == 1

	# Public/anonymous access - create a client without authentication
	with use_anon_client() as public_client:
		# Public can see public dataset through the view
		response = (
			public_client.from_('v2_full_dataset_view')
			.select('*')
			.eq('id', datasets_with_mixed_access['public_id'])
			.execute()
		)
		assert len(response.data) == 1

		# Public cannot see private dataset through the view
		response = (
			public_client.from_('v2_full_dataset_view')
			.select('*')
			.eq('id', datasets_with_mixed_access['private_id'])
			.execute()
		)
		assert len(response.data) == 0


def test_archive_items_include_private_datasets_for_authorized_users(
	archive_ready_private_dataset,
	setup_processor_privileges,
	test_processor_user,
	test_user2,
):
	"""The archive map/list feed should include private rows only for authorized users."""
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)
	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)
	other_user_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_anon_client() as client:
		response = (
			client.from_('public_dataset_archive_items')
			.select('id,data_access')
			.eq('id', archive_ready_private_dataset)
			.execute()
		)
		assert len(response.data) == 0

	with use_client(other_user_token) as client:
		response = (
			client.from_('public_dataset_archive_items')
			.select('id,data_access')
			.eq('id', archive_ready_private_dataset)
			.execute()
		)
		assert len(response.data) == 0

	with use_client(user_token) as client:
		response = (
			client.from_('public_dataset_archive_items')
			.select('id,data_access')
			.eq('id', archive_ready_private_dataset)
			.execute()
		)
		assert len(response.data) == 1
		assert response.data[0]['data_access'] == DatasetAccessEnum.private.value

	with use_client(processor_token) as client:
		response = (
			client.from_('public_dataset_archive_items')
			.select('id,data_access')
			.eq('id', archive_ready_private_dataset)
			.execute()
		)
		assert len(response.data) == 1
		assert response.data[0]['data_access'] == DatasetAccessEnum.private.value

	with use_client(processor_token) as client:
		client.table('dataset_audit').insert(
			{
				'dataset_id': archive_ready_private_dataset,
				'audited_by': test_processor_user,
				'final_assessment': 'exclude_completely',
			}
		).execute()

	with use_client(user_token) as client:
		response = (
			client.from_('public_dataset_archive_items')
			.select('id,data_access')
			.eq('id', archive_ready_private_dataset)
			.execute()
		)
		assert len(response.data) == 0

	with use_client(processor_token) as client:
		response = (
			client.from_('public_dataset_archive_items')
			.select('id,data_access')
			.eq('id', archive_ready_private_dataset)
			.execute()
		)
		assert len(response.data) == 0


def test_label_rls_policy_follows_dataset_visibility(
	datasets_with_mixed_access, auth_token, test_user, test_processor_user
):
	"""Raw label reads should not reveal labels for private datasets to anonymous clients."""
	with use_service_client() as owner_client:
		public_label = {
			'dataset_id': datasets_with_mixed_access['public_id'],
			'user_id': test_user,
			'label_source': LabelSourceEnum.visual_interpretation,
			'label_type': LabelTypeEnum.semantic_segmentation,
			'label_data': LabelDataEnum.deadwood,
			'label_quality': 1,
		}
		private_label = {
			**public_label,
			'dataset_id': datasets_with_mixed_access['private_id'],
		}
		public_forest_cover_label = {
			**public_label,
			'label_data': LabelDataEnum.forest_cover,
		}
		private_forest_cover_label = {
			**private_label,
			'label_data': LabelDataEnum.forest_cover,
		}
		response = (
			owner_client.table(settings.labels_table)
			.insert([public_label, private_label, public_forest_cover_label, private_forest_cover_label])
			.execute()
		)
		label_ids_by_dataset_and_data = {
			(row['dataset_id'], row['label_data']): row['id'] for row in response.data
		}
		inserted_label_ids = set(label_ids_by_dataset_and_data.values())
		public_deadwood_label_id = label_ids_by_dataset_and_data[
			(datasets_with_mixed_access['public_id'], LabelDataEnum.deadwood)
		]
		private_deadwood_label_id = label_ids_by_dataset_and_data[
			(datasets_with_mixed_access['private_id'], LabelDataEnum.deadwood)
		]
		public_forest_cover_label_id = label_ids_by_dataset_and_data[
			(datasets_with_mixed_access['public_id'], LabelDataEnum.forest_cover)
		]
		private_forest_cover_label_id = label_ids_by_dataset_and_data[
			(datasets_with_mixed_access['private_id'], LabelDataEnum.forest_cover)
		]
		geometry = {
			'type': 'Polygon',
			'coordinates': [
				[
					[7.0, 47.0],
					[7.0, 47.1],
					[7.1, 47.1],
					[7.1, 47.0],
					[7.0, 47.0],
				]
			],
		}
		geometry_response = (
			owner_client.table(settings.deadwood_geometries_table)
			.insert(
				[
					{
						'label_id': public_deadwood_label_id,
						'geometry': geometry,
						'properties': {'fixture': 'public'},
					},
					{
						'label_id': private_deadwood_label_id,
						'geometry': geometry,
						'properties': {'fixture': 'private'},
					},
				]
			)
			.execute()
		)
		inserted_deadwood_geometry_ids = {row['id'] for row in geometry_response.data}
		geometry_response = (
			owner_client.table(settings.forest_cover_geometries_table)
			.insert(
				[
					{
						'label_id': public_forest_cover_label_id,
						'geometry': geometry,
						'properties': {'fixture': 'public'},
					},
					{
						'label_id': private_forest_cover_label_id,
						'geometry': geometry,
						'properties': {'fixture': 'private'},
					},
				]
			)
			.execute()
		)
		inserted_forest_cover_geometry_ids = {row['id'] for row in geometry_response.data}

	with use_anon_client() as public_client:
		response = (
			public_client.table(settings.labels_table)
			.select('id,dataset_id')
			.in_('id', list(inserted_label_ids))
			.execute()
		)
		visible_dataset_ids = {row['dataset_id'] for row in response.data}
		assert visible_dataset_ids == {datasets_with_mixed_access['public_id']}

		response = (
			public_client.table(settings.deadwood_geometries_table)
			.select('id,label_id')
			.in_('id', list(inserted_deadwood_geometry_ids))
			.execute()
		)
		visible_label_ids = {row['label_id'] for row in response.data}
		assert visible_label_ids == {public_deadwood_label_id}

		response = (
			public_client.table(settings.forest_cover_geometries_table)
			.select('id,label_id')
			.in_('id', list(inserted_forest_cover_geometry_ids))
			.execute()
		)
		visible_label_ids = {row['label_id'] for row in response.data}
		assert visible_label_ids == {public_forest_cover_label_id}

	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)
	with use_client(processor_token) as processor_client:
		processor_client.table('dataset_audit').insert(
			{
				'dataset_id': datasets_with_mixed_access['public_id'],
				'audited_by': test_processor_user,
				'final_assessment': 'exclude_completely',
			}
		).execute()

	with use_anon_client() as public_client:
		response = (
			public_client.table(settings.labels_table)
			.select('id,dataset_id')
			.in_('id', list(inserted_label_ids))
			.execute()
		)
		assert response.data == []

		response = (
			public_client.table(settings.deadwood_geometries_table)
			.select('id,label_id')
			.in_('id', list(inserted_deadwood_geometry_ids))
			.execute()
		)
		assert response.data == []

		response = (
			public_client.table(settings.forest_cover_geometries_table)
			.select('id,label_id')
			.in_('id', list(inserted_forest_cover_geometry_ids))
			.execute()
		)
		assert response.data == []

	with use_client(auth_token) as owner_client:
		response = (
			owner_client.table(settings.labels_table)
			.select('id,dataset_id')
			.in_('id', list(inserted_label_ids))
			.execute()
		)
		visible_dataset_ids = {row['dataset_id'] for row in response.data}
		assert visible_dataset_ids == {
			datasets_with_mixed_access['public_id'],
			datasets_with_mixed_access['private_id'],
		}

		response = (
			owner_client.table(settings.deadwood_geometries_table)
			.select('id,label_id')
			.in_('id', list(inserted_deadwood_geometry_ids))
			.execute()
		)
		visible_label_ids = {row['label_id'] for row in response.data}
		assert visible_label_ids == {public_deadwood_label_id, private_deadwood_label_id}

		response = (
			owner_client.table(settings.forest_cover_geometries_table)
			.select('id,label_id')
			.in_('id', list(inserted_forest_cover_geometry_ids))
			.execute()
		)
		visible_label_ids = {row['label_id'] for row in response.data}
		assert visible_label_ids == {public_forest_cover_label_id, private_forest_cover_label_id}
