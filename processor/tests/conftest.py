import pytest
from datetime import datetime
import shutil
from pathlib import Path
import logging


from shared.db import use_client
from shared.settings import settings
from shared.models import StatusEnum, Ortho
from processor.src.utils.ssh import push_file_to_storage_server, cleanup_storage_server_directory
from shared.testing.fixtures import (
	auth_token,
	test_file,
	test_processor_user,
	cleanup_database,
	data_directory,
)


@pytest.fixture(scope='session')
def ensure_gadm_data():
	"""Ensure GADM data is available for tests"""
	gadm_path = Path(settings.GADM_DATA_PATH)
	if not gadm_path.exists():
		pytest.skip(f'GADM data not found at {gadm_path}. Run `make download-assets` to download required data files.')
	return gadm_path


@pytest.fixture(scope='function')
def test_dataset_for_processing(auth_token, test_file, test_processor_user):
	"""Create a test dataset and copy file to archive directory"""
	dataset_id = None
	file_name = 'test-process.tif'

	try:
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
			ortho_file_name = f'{dataset_id}_ortho.tif'

			ortho_path = Path(settings.BASE_DIR) / settings.ARCHIVE_DIR / ortho_file_name
			push_file_to_storage_server(test_file, str(ortho_path), auth_token, dataset_id)

			# Add ortho entry
			ortho_data = {
				'dataset_id': dataset_id,
				'ortho_file_name': ortho_file_name,
				'version': 1,
				'ortho_file_size': max(1, int((test_file.stat().st_size / 1024 / 1024))),  # in MB
				'bbox': 'BOX(13.4050 52.5200,13.4150 52.5300)',  # Example bbox for Berlin
				'ortho_upload_runtime': 0.1,
				'ortho_processed': False,
				'ortho_original_info': {'Driver': 'GTiff', 'Size': [1024, 1024]},
				'created_at': datetime.now(),
			}
			ortho = Ortho(**ortho_data)
			client.table(settings.orthos_table).insert(ortho.model_dump()).execute()

			# Create initial status entry with is_upload_done set to True
			status_data = {
				'dataset_id': dataset_id,
				'current_status': StatusEnum.idle,
				'is_upload_done': True,  # This is needed for processing to begin
				'is_ortho_done': False,
				'is_cog_done': False,
				'is_thumbnail_done': False,
				'is_deadwood_done': False,
				'is_forest_cover_done': False,
				'is_metadata_done': False,
				'is_audited': False,
				'has_error': False,
			}
			client.table(settings.statuses_table).insert(status_data).execute()

			yield dataset_id

	finally:
		# Cleanup
		if dataset_id:
			with use_client(auth_token) as client:
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()

				# delete logs table all entries
				client.table(settings.logs_table).delete().neq('id', 1).execute()

		# if archive_path.exists():
		# 	archive_path.unlink()
		# clean processing directory
		shutil.rmtree(settings.processing_path)


@pytest.fixture(autouse=True)
def cleanup_storage():
	"""Clean up storage before and after each test"""
	# Safety check to prevent running in production
	if not settings.ENV.lower() == 'development':
		pytest.skip('Cleanup fixture should only run in development environment')
		return

	if not settings.DEV_MODE:
		pytest.skip('Cleanup fixture should only run in development mode')
		return

	token = auth_token

	# Paths to clean
	paths = [
		f'{settings.STORAGE_SERVER_DATA_PATH}/{settings.ARCHIVE_DIR}',
		# f'{settings.STORAGE_SERVER_DATA_PATH}/{settings.PROCESSING_DIR}',
		f'{settings.STORAGE_SERVER_DATA_PATH}/{settings.COG_DIR}',
		f'{settings.STORAGE_SERVER_DATA_PATH}/{settings.THUMBNAIL_DIR}',
		f'{settings.STORAGE_SERVER_DATA_PATH}/{settings.TRASH_DIR}',
	]

	# Clean before test
	for path in paths:
		try:
			cleanup_storage_server_directory(path, token)
		except Exception as e:
			print(f'Pre-test cleanup warning: {str(e)}', extra={'token': token})

	yield

	# Clean after test
	for path in paths:
		try:
			cleanup_storage_server_directory(path, token)
		except Exception as e:
			print(f'Post-test cleanup warning: {str(e)}', extra={'token': token})

	# Clean local processing directory
	if Path(settings.processing_path).exists():
		shutil.rmtree(settings.processing_path, ignore_errors=True)


@pytest.fixture(scope='session', autouse=True)
def handle_logging_cleanup():
	"""Ensure logging handlers are properly cleaned up after all tests."""
	yield

	# Get all loggers
	loggers = [logging.getLogger(name) for name in logging.root.manager.loggerDict]

	# Remove handlers carefully
	for logger in loggers:
		if hasattr(logger, 'handlers'):
			for handler in logger.handlers[:]:
				# Prevent handler from closing if it's still needed
				try:
					handler.acquire()
					handler.flush()
					handler.close()
				except (OSError, ValueError):
					pass  # Ignore errors from already closed handlers
				finally:
					handler.release()
					logger.removeHandler(handler)

	# Reset logging configuration
	logging.shutdown()
