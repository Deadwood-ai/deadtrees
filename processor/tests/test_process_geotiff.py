import pytest

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask
from processor.src.process_geotiff import process_geotiff


@pytest.fixture
def convert_task(test_dataset_for_processing, test_processor_user):
	"""Create a test task for GeoTIFF conversion"""
	return QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.geotiff],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={},
	)


def test_process_geotiff_success(convert_task, auth_token):
	"""Test successful GeoTIFF conversion and info creation"""
	process_geotiff(convert_task, settings.processing_path)

	# Verify GeoTIFF info was created
	with use_client(auth_token) as client:
		response = (
			client.table(settings.orthos_processed_table)
			.select('*')
			.eq('dataset_id', convert_task.dataset_id)
			.execute()
		)
		assert len(response.data) == 1
		data = response.data[0]

		# Verify essential GeoTIFF info fields
		assert data['dataset_id'] == convert_task.dataset_id
		assert data['ortho_file_name'].endswith('ortho.tif')
		assert data['ortho_processing_runtime'] > 0
		assert data['ortho_info']['Compression'] == 'DEFLATE'

		# Clean up by removing the test entry
		client.table(settings.orthos_processed_table).delete().eq('dataset_id', convert_task.dataset_id).execute()
