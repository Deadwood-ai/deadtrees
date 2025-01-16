import pytest
import tempfile
import shutil
from pathlib import Path
from shared.supabase import use_client, login
from shared.settings import settings
from unittest.mock import patch
from supabase import create_client

DATASET_ID = 275


@pytest.fixture(scope='session', autouse=True)
def create_processor_user():
	"""Create the processor user in the database if it doesn't exist and clean up after tests"""
	supabase = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
	user_id = None

	try:
		# Try to sign up the processor user
		response = supabase.auth.sign_up(
			{
				'email': settings.PROCESSOR_USERNAME,
				'password': settings.PROCESSOR_PASSWORD,
			}
		)
		user_id = response.user.id if response.user else None
	except Exception as e:
		# If user already exists, try to get the user ID
		try:
			response = supabase.auth.sign_in_with_password(
				{
					'email': settings.PROCESSOR_USERNAME,
					'password': settings.PROCESSOR_PASSWORD,
				}
			)
			user_id = response.user.id if response.user else None
		except Exception as sign_in_error:
			print(f'Note: Processor user setup - {str(sign_in_error)}')

	# Yield to run tests
	yield

	# Cleanup: Delete the processor user if we have their ID
	if user_id:
		try:
			# Need admin token to delete user
			supabase.auth.admin.delete_user(user_id)
			print(f'Successfully deleted processor user with ID: {user_id}')
		except Exception as e:
			print(f'Failed to delete processor user: {str(e)}')


@pytest.fixture
def test_file():
	"""Fixture to provide test GeoTIFF file path"""
	file_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'test-data-small.tif'
	if not file_path.exists():
		pytest.skip('Test file not found')
	return file_path


@pytest.fixture(scope='session')
def auth_token():
	"""Provide authentication token for tests"""
	return login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)


@pytest.fixture(autouse=True)
def mock_data_directory(test_file):
	"""Replace /data with a temporary directory during tests"""
	with tempfile.TemporaryDirectory() as temp_dir:
		temp_path = Path(temp_dir)

		# Create a mock property that returns our temp path
		def get_base_path(self):
			return temp_path

		def get_archive_path(self):
			return temp_path

		# Patch both properties
		with patch('shared.settings.Settings.base_path', new_callable=property, fget=get_base_path):
			with patch('shared.settings.Settings.archive_path', new_callable=property, fget=get_archive_path):
				yield temp_path  # Return the temp_path instead of temp_dir


@pytest.fixture(autouse=True)
def ensure_gadm_data():
	"""Ensure GADM data is available for tests"""
	gadm_path = Path(settings.GADM_DATA_PATH)
	if not gadm_path.exists():
		pytest.skip(
			f'GADM data not found at {gadm_path}. ' 'Run `make download-assets` to download required data files.'
		)
	return gadm_path
