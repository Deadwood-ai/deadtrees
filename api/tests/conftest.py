import pytest
import shutil
from pathlib import Path
from shared.db import use_client, login
from shared.settings import settings
from supabase import create_client


@pytest.fixture(scope='session')
def ensure_gadm_data():
	"""Ensure GADM data is available for tests"""
	gadm_path = Path(settings.GADM_DATA_PATH)
	if not gadm_path.exists():
		pytest.skip(
			f'GADM data not found at {gadm_path}. ' 'Run `make download-assets` to download required data files.'
		)
	return gadm_path


@pytest.fixture(scope='session', autouse=True)
def data_directory():
	"""Create and manage the data directory structure for tests"""
	# Create the data directory structure
	data_dir = Path(settings.BASE_DIR)
	archive_dir = data_dir / settings.ARCHIVE_DIR
	cogs_dir = data_dir / settings.COG_DIR
	thumbnails_dir = data_dir / settings.THUMBNAIL_DIR
	label_objects_dir = data_dir / settings.LABEL_OBJECTS_DIR
	downloads_dir = data_dir / settings.DOWNLOADS_DIR

	# Create all directories
	for directory in [archive_dir, cogs_dir, thumbnails_dir, label_objects_dir, downloads_dir]:
		directory.mkdir(parents=True, exist_ok=True)

	yield data_dir

	# Cleanup after all tests
	for directory in [archive_dir, cogs_dir, thumbnails_dir, label_objects_dir, downloads_dir]:
		if directory.exists():
			shutil.rmtree(directory)
			directory.mkdir(parents=True, exist_ok=True)


@pytest.fixture(scope='session')
def test_geotiff():
	"""Provide the test GeoTIFF file path from assets"""
	file_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'test-data-small.tif'
	if not file_path.exists():
		pytest.skip('Test file not found in assets. Run `make download-assets` first.')
	return file_path


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

	# Cleanup: Delete the test user
	# if user_id:
	# 	try:
	# 		admin_client = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_KEY)
	# 		admin_client.auth.admin.delete_user(user_id)
	# 	except Exception as e:
	# 		print(f'Failed to delete test user: {str(e)}')


@pytest.fixture(scope='session')
def auth_token(test_user):
	"""Provide authentication token for tests"""
	return login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD)


@pytest.fixture(scope='session', autouse=True)
def cleanup_database(auth_token):
	"""Clean up database tables after all tests"""
	yield

	with use_client(auth_token) as client:
		# With CASCADE delete, we only need to clean the parent table
		try:
			client.table(settings.datasets_table).delete().neq('id', 0).execute()
		except Exception as e:
			print(f'Warning: Failed to clean up datasets: {str(e)}')
