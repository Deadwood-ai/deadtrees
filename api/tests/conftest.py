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


@pytest.fixture(scope='session')
def ensure_gadm_data():
	"""Ensure GADM data is available for tests"""
	gadm_path = Path(settings.GADM_DATA_PATH)
	if not gadm_path.exists():
		pytest.skip(
			f'GADM data not found at {gadm_path}. ' 'Run `make download-assets` to download required data files.'
		)
	return gadm_path


@pytest.fixture(scope='session')
def data_directory():
	"""Create and manage the data directory structure for tests"""
	# Create the data directory structure
	data_dir = Path(settings.BASE_DIR)
	# archive_dir = data_dir / settings.ARCHIVE_DIR
	# archive_dir.mkdir(parents=True, exist_ok=True)

	yield data_dir

	# Cleanup after all tests
	# if data_dir.exists():
	# shutil.rmtree(data_dir)


@pytest.fixture(scope='session')
def test_geotiff():
	"""Provide the test GeoTIFF file path from assets"""
	file_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'test-data-small.tif'
	if not file_path.exists():
		pytest.skip('Test file not found in assets. Run `make download-assets` first.')
	return file_path


@pytest.fixture(scope='session', autouse=True)
def test_user():
	"""Create a test user for all tests and clean up afterwards"""
	supabase = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
	test_email = 'test@example.com'
	test_password = 'test123456'
	user_id = None

	try:
		# Try to sign up the test user
		response = supabase.auth.sign_up(
			{
				'email': test_email,
				'password': test_password,
			}
		)
		user_id = response.user.id if response.user else None
	except Exception:
		# If user exists, try to get the user ID
		try:
			response = supabase.auth.sign_in_with_password(
				{
					'email': test_email,
					'password': test_password,
				}
			)
			user_id = response.user.id if response.user else None
		except Exception as e:
			pytest.fail(f'Could not create or retrieve test user: {str(e)}')

	yield user_id

	# Cleanup: Delete the test user
	if user_id:
		try:
			supabase.auth.admin.delete_user(user_id)
		except Exception as e:
			print(f'Failed to delete test user: {str(e)}')


@pytest.fixture(scope='session')
def auth_token():
	"""Provide authentication token for tests"""
	return login('test@example.com', 'test123456')
