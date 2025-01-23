import pytest
import shutil
from pathlib import Path


from supabase import create_client
from shared.db import login, use_client
from shared.settings import settings


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

	# Cleanup: Delete the processor user if we have their ID
	if user_id:
		try:
			# Need admin token to delete user
			supabase.auth.admin.delete_user(user_id)
			print(f'Successfully deleted processor user with ID: {user_id}')
		except Exception as e:
			print(f'Failed to delete processor user: {str(e)}')


@pytest.fixture(scope='session')
def auth_token(test_processor_user):
	"""Provide authentication token for tests"""
	return login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)


@pytest.fixture
def test_file():
	"""Fixture to provide test GeoTIFF file path"""
	file_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'test-data-small.tif'
	if not file_path.exists():
		pytest.skip('Test file not found')
	return file_path


# @pytest.fixture()
# def patch_test_file(test_file, auth_token):
# 	"""Fixture to provide test file for thumbnail testing"""
# 	# Create processing directory if it doesn't exist
# 	settings.processing_path.mkdir(parents=True, exist_ok=True)

# 	try:
# 		with use_client(auth_token) as client:
# 			response = client.table(settings.datasets_table).select('file_name').eq('id', DATASET_ID).execute()
# 			file_name = response.data[0]['file_name']
# 		if not response.data:
# 			pytest.skip('Dataset not found in database')

# 		# Copy file to processing directory
# 		dest_path = settings.processing_path / file_name
# 		shutil.copy2(test_file, dest_path)

# 		yield test_file

# 	finally:
# 		# Cleanup processing directory after test
# 		if settings.processing_path.exists():
# 			shutil.rmtree(settings.processing_path)


@pytest.fixture(scope='session', autouse=True)
def data_directory():
	"""Create and manage the data directory structure for tests"""
	# Create the data directory structure
	data_dir = Path(settings.BASE_DIR)
	archive_dir = data_dir / settings.ARCHIVE_DIR
	cogs_dir = data_dir / settings.COG_DIR
	thumbnails_dir = data_dir / settings.THUMBNAIL_DIR
	label_objects_dir = data_dir / settings.LABEL_OBJECTS_DIR
	trash_dir = data_dir / settings.TRASH_DIR

	# Create all directories
	for directory in [archive_dir, cogs_dir, thumbnails_dir, label_objects_dir, trash_dir]:
		directory.mkdir(parents=True, exist_ok=True)

	yield data_dir

	# Cleanup after all tests
	for directory in [archive_dir, cogs_dir, thumbnails_dir, label_objects_dir, trash_dir]:
		if directory.exists():
			shutil.rmtree(directory)
			directory.mkdir(parents=True, exist_ok=True)


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


@pytest.fixture(scope='function')
def test_dataset_for_processing(auth_token, test_file, test_processor_user):
	"""Create a test dataset and copy file to archive directory"""
	dataset_id = None
	file_name = 'test-process.tif'

	try:
		# Copy test file to archive directory
		archive_path = Path(settings.BASE_DIR) / settings.ARCHIVE_DIR / file_name
		shutil.copy2(test_file, archive_path)

		# Create test dataset in database
		with use_client(auth_token) as client:
			dataset_data = {
				'file_name': file_name,
				'license': 'CC BY',
				'platform': 'drone',
				'authors': ['Test Author'],
				'user_id': test_processor_user,
				'data_access': 'public',
			}
			response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = response.data[0]['id']

			# Add ortho entry
			ortho_data = {
				'dataset_id': dataset_id,
				'ortho_file_name': file_name,
				'version': 1,
				'file_size': archive_path.stat().st_size,
				'bbox': 'BOX(13.4050 52.5200,13.4150 52.5300)',  # Example bbox for Berlin
				'ortho_upload_runtime': 0.1,
				'ortho_processing': False,
				'ortho_processed': False,
			}
			client.table(settings.orthos_table).insert(ortho_data).execute()

			# Create initial status entry
			status_data = {
				'dataset_id': dataset_id,
				'current_status': 'idle',
			}
			client.table(settings.statuses_table).insert(status_data).execute()

			yield dataset_id

	finally:
		# Cleanup
		if dataset_id:
			with use_client(auth_token) as client:
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()

		if archive_path.exists():
			archive_path.unlink()
