import pytest
from shared.db import use_client, login
from shared.settings import settings
from shared.models import DatasetAccessEnum, LicenseEnum, PlatformEnum


@pytest.fixture(scope='function')
def datasets_with_mixed_access(auth_token, test_user):
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


def test_rls_policy_for_private_datasets(datasets_with_mixed_access, auth_token):
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
	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
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
