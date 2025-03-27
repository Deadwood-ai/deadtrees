import pytest
from pathlib import Path
from supabase import create_client
from shared.settings import settings
from shared.db import login, use_client
import shutil
from .safety import test_environment_only


@pytest.fixture(scope='session', autouse=True)
def test_processor_user():
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
	except Exception:
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
	yield user_id

	# # Cleanup: Delete the processor user if we have their ID
	# if user_id:
	# 	try:
	# 		# Need admin token to delete user
	# 		supabase.auth.admin.delete_user(user_id)
	# 		print(f'Successfully deleted processor user with ID: {user_id}')
	# 	except Exception as e:
	# 		print(f'Failed to delete processor user: {str(e)}')


@pytest.fixture(scope='session')
def auth_token(test_processor_user):
	"""Provide authentication token for tests"""
	return login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)


@pytest.fixture
def test_file():
	"""Fixture to provide test GeoTIFF file path"""
	file_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'test-data.tif'
	# file_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'float-ortho-poland.tif'
	# file_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'fva_offset_bug.tif'
	# file_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'test-data-small.tif'
	# file_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'corrupted-crs-small.tif'
	# file_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'utm.tif'
	# file_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'debugging' / 'ortho_3824_geonadir_location_problem.tif'
	# file_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'debugging' / 'fva_no_segmentation.tif'
	# file_path = (
	# 	Path(__file__).parent.parent.parent
	# 	/ 'assets'
	# 	/ 'test_data'
	# 	/ 'debugging'
	# 	/ 'Beutelsdorf_20160926_reordered-upload-error.tif'
	# )

	if not file_path.exists():
		pytest.skip('Test file not found')
	return file_path


@pytest.fixture(scope='session', autouse=True)
@test_environment_only
def cleanup_database(auth_token):
	"""Clean up database tables after all tests"""
	yield

	with use_client(auth_token) as client:
		# With CASCADE delete, we only need to clean the parent table
		client.table(settings.datasets_table).delete().neq('id', 0).execute()
		client.table(settings.logs_table).delete().neq('id', 1).execute()


@pytest.fixture(scope='session', autouse=True)
@test_environment_only
def data_directory(request):
	"""Create and manage the data directory structure for tests"""
	# Create the data directory structure
	data_dir = Path(settings.BASE_DIR)
	directories = [
		data_dir / settings.ARCHIVE_DIR,
		data_dir / settings.COG_DIR,
		data_dir / settings.THUMBNAIL_DIR,
		data_dir / settings.LABEL_OBJECTS_DIR,
		data_dir / settings.TRASH_DIR,
		data_dir / settings.DOWNLOADS_DIR,
	]

	# Create all directories
	for directory in directories:
		directory.mkdir(parents=True, exist_ok=True)

	# Register cleanup function to run at the end of session
	def cleanup():
		for directory in directories:
			if directory.exists():
				shutil.rmtree(directory)
				directory.mkdir(parents=True, exist_ok=True)

	# Register the cleanup to run at the end of the session
	request.addfinalizer(cleanup)

	# Return the Path object directly
	return data_dir
