import pytest
from shared.db import use_client, login
from shared.settings import settings
from shared.models import DatasetAccessEnum, LicenseEnum, PlatformEnum
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
	with use_client() as public_client:
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
	with use_client() as public_client:
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
