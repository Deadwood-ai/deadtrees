import pytest
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask
from processor.src.process_cog import process_cog
from processor.src.process_thumbnail import process_thumbnail
from processor.src.utils.ssh import check_file_exists_on_storage


@pytest.fixture
def thumbnail_task(test_dataset_for_processing, test_processor_user):
	"""Create a test task specifically for thumbnail processing"""
	return QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.thumbnail],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={},
	)


@pytest.fixture
def cog_task(test_dataset_for_processing, test_processor_user):
	"""Create a test task for COG processing"""
	return QueueTask(
		id=2,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.cog],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
	)


def test_process_thumbnail_success(cog_task, thumbnail_task, auth_token):
	"""Test successful thumbnail processing using COG"""
	# First process the COG since it's required for thumbnail generation
	process_cog(cog_task, settings.processing_path)

	# Now process the thumbnail
	process_thumbnail(thumbnail_task, settings.processing_path)

	# Verify both COG and thumbnail were created in database
	with use_client(auth_token) as client:
		# Verify COG data
		cog_response = (
			client.table(settings.cogs_table).select('*').eq('dataset_id', thumbnail_task.dataset_id).execute()
		)
		assert len(cog_response.data) == 1
		cog_data = cog_response.data[0]
		assert cog_data['dataset_id'] == thumbnail_task.dataset_id
		assert cog_data['cog_file_name'].endswith('cog.tif')

		# Verify thumbnail data
		thumbnail_response = (
			client.table(settings.thumbnails_table).select('*').eq('dataset_id', thumbnail_task.dataset_id).execute()
		)
		assert len(thumbnail_response.data) == 1
		thumbnail_data = thumbnail_response.data[0]
		assert thumbnail_data['dataset_id'] == thumbnail_task.dataset_id

		# Verify thumbnail file exists on storage server
		storage_server_path = f'{settings.STORAGE_SERVER_DATA_PATH}/thumbnails/{thumbnail_data["thumbnail_path"]}'
		assert check_file_exists_on_storage(storage_server_path, auth_token), (
			'Thumbnail file not found on storage server'
		)

		# Clean up by removing the test entries
		client.table(settings.thumbnails_table).delete().eq('dataset_id', thumbnail_task.dataset_id).execute()
		client.table(settings.cogs_table).delete().eq('dataset_id', thumbnail_task.dataset_id).execute()


def test_process_thumbnail_requires_cog(thumbnail_task, auth_token):
	"""Test that thumbnail processing fails when COG doesn't exist"""
	# Try to process thumbnail without processing COG first
	with pytest.raises(Exception) as excinfo:
		process_thumbnail(thumbnail_task, settings.processing_path)

	# Verify that the error message indicates COG processing is required first
	assert 'COG processing must be completed' in str(excinfo.value)
