import pytest
import shutil
from pathlib import Path
from shared.db import use_client, login
from shared.settings import settings
from supabase import create_client
from shared.models import DatasetAccessEnum, LicenseEnum, PlatformEnum

from shared.testing.fixtures import test_file, cleanup_database, data_directory, test_processor_user


@pytest.fixture(scope='session')
def test_user():
	"""Create a test user for all tests and clean up afterwards"""
	supabase = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
	user_id = None

	try:
		# Try to sign up the test user
		response = supabase.auth.sign_up(
			{
				'email': settings.TEST_USER_EMAIL,
				'password': settings.TEST_USER_PASSWORD,
			}
		)
		user_id = response.user.id if response.user else None
	except Exception:
		# If user exists, try to get the user ID
		try:
			response = supabase.auth.sign_in_with_password(
				{
					'email': settings.TEST_USER_EMAIL,
					'password': settings.TEST_USER_PASSWORD,
				}
			)
			user_id = response.user.id if response.user else None
		except Exception as e:
			pytest.fail(f'Could not create or retrieve test user: {str(e)}')

	yield user_id


@pytest.fixture(scope='session')
def test_user2():
	"""Create a test user for all tests and clean up afterwards"""
	supabase = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
	user_id = None

	try:
		# Try to sign up the test user
		response = supabase.auth.sign_up(
			{
				'email': settings.TEST_USER_EMAIL2,
				'password': settings.TEST_USER_PASSWORD2,
			}
		)
		user_id = response.user.id if response.user else None
	except Exception:
		# If user exists, try to get the user ID
		try:
			response = supabase.auth.sign_in_with_password(
				{
					'email': settings.TEST_USER_EMAIL2,
					'password': settings.TEST_USER_PASSWORD2,
				}
			)
			user_id = response.user.id if response.user else None
		except Exception as e:
			pytest.fail(f'Could not create or retrieve test user: {str(e)}')

	yield user_id


@pytest.fixture(scope='session')
def auth_token(test_user):
	"""Provide authentication token for tests"""
	return login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD)


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
