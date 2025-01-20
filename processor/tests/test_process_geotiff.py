import pytest

from shared.supabase import use_client
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
		task_types=[TaskTypeEnum.convert_geotiff],
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
			client.table(settings.geotiff_info_table).select('*').eq('dataset_id', convert_task.dataset_id).execute()
		)
		assert len(response.data) == 1
		geotiff_info = response.data[0]

		# Verify essential GeoTIFF info fields
		# TODO: Add check for the filesystem processor and nginx
		assert geotiff_info['dataset_id'] == convert_task.dataset_id
		assert geotiff_info['driver'] == 'GTiff'
		assert geotiff_info['size_width'] > 0
		assert geotiff_info['size_height'] > 0
		assert geotiff_info['file_size_gb'] > 0
		assert geotiff_info['band_count'] > 0
		assert isinstance(geotiff_info['band_types'], list)
		assert isinstance(geotiff_info['band_interpretations'], list)
		assert len(geotiff_info['band_types']) == geotiff_info['band_count']
		assert len(geotiff_info['band_interpretations']) == geotiff_info['band_count']
		assert geotiff_info['crs'] is not None
		assert geotiff_info['pixel_size_x'] > 0
		assert geotiff_info['pixel_size_y'] > 0
		assert geotiff_info['block_size_x'] > 0
		assert geotiff_info['block_size_y'] > 0
		assert isinstance(geotiff_info['is_tiled'], bool)
		assert isinstance(geotiff_info['is_bigtiff'], bool)

		# Clean up by removing the test entry
		client.table(settings.geotiff_info_table).delete().eq('dataset_id', convert_task.dataset_id).execute()
