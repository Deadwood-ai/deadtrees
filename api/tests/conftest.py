import pytest
import tempfile
import shutil
from pathlib import Path
from shared.supabase import use_client, login
from shared.settings import settings
from unittest.mock import patch
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

	# Create all directories
	for directory in [archive_dir, cogs_dir, thumbnails_dir, label_objects_dir]:
		directory.mkdir(parents=True, exist_ok=True)

	yield data_dir

	# Cleanup after all tests
	for directory in [archive_dir, cogs_dir, thumbnails_dir, label_objects_dir]:
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


@pytest.fixture(scope='session', autouse=True)
def cleanup_database(auth_token):
	"""Clean up database tables after all tests"""
	yield

	with use_client(auth_token) as client:
		# Clean up all test tables in reverse order of dependencies
		tables = [
			settings.queue_table,
			settings.label_objects_table,
			settings.labels_table,
			settings.thumbnails_table,
			settings.cogs_table,
			settings.geotiff_info_table,
			settings.metadata_table,
			settings.datasets_table,
		]

		for table in tables:
			try:
				client.table(table).delete().neq('id', 0).execute()
			except Exception as e:
				print(f'Warning: Failed to clean up table {table}: {str(e)}')
