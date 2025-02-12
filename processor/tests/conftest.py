import pytest
from datetime import datetime
import shutil
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import StatusEnum, Ortho
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
				'ortho_processed': False,
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

		if archive_path.exists():
			archive_path.unlink()
		# clean processing directory
		shutil.rmtree(settings.processing_path)
