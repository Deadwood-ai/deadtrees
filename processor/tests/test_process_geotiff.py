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
	"""Test successful GeoTIFF conversion with fresh metadata calculation and both database entries creation"""
	process_geotiff(convert_task, settings.processing_path)

	with use_client(auth_token) as client:
		# Verify original ortho entry exists with fresh metadata (always recalculated)
		ortho_response = (
			client.table(settings.orthos_table).select('*').eq('dataset_id', convert_task.dataset_id).execute()
		)
		assert len(ortho_response.data) == 1
		ortho_data = ortho_response.data[0]

		# Verify essential original ortho fields with fresh metadata
		assert ortho_data['dataset_id'] == convert_task.dataset_id
		assert ortho_data['ortho_file_name'].endswith('ortho.tif')
		assert ortho_data['version'] == 1
		# sha256 and ortho_info should always be freshly calculated
		assert ortho_data['sha256'] is not None
		assert ortho_data['ortho_info'] is not None
		assert ortho_data['bbox'] is not None

		# Verify processed GeoTIFF info was created (existing functionality)
		processed_response = (
			client.table(settings.orthos_processed_table)
			.select('*')
			.eq('dataset_id', convert_task.dataset_id)
			.execute()
		)
		assert len(processed_response.data) == 1
		processed_data = processed_response.data[0]

		# Verify essential processed GeoTIFF info fields
		assert processed_data['dataset_id'] == convert_task.dataset_id
		assert processed_data['ortho_file_name'].endswith('ortho.tif')
		assert processed_data['ortho_processing_runtime'] > 0
		# Compression should be preserved or DEFLATE (JPEG may be converted to DEFLATE if alpha needed)
		compression = processed_data['ortho_info']['Compression']
		assert compression in ['DEFLATE', 'JPEG', 'WEBP'], f'Unexpected compression: {compression}'

		# Clean up by removing both test entries
		client.table(settings.orthos_processed_table).delete().eq('dataset_id', convert_task.dataset_id).execute()
		client.table(settings.orthos_table).delete().eq('dataset_id', convert_task.dataset_id).execute()
