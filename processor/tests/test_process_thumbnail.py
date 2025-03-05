import pytest
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask
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


def test_process_thumbnail_success(thumbnail_task, auth_token):
	"""Test successful thumbnail processing"""
	process_thumbnail(thumbnail_task, settings.processing_path)

	with use_client(auth_token) as client:
		response = (
			client.table(settings.thumbnails_table).select('*').eq('dataset_id', thumbnail_task.dataset_id).execute()
		)
		assert len(response.data) == 1
		thumbnail_data = response.data[0]
		assert thumbnail_data['dataset_id'] == thumbnail_task.dataset_id

		# Verify thumbnail file exists on storage server
		storage_server_path = f'{settings.STORAGE_SERVER_DATA_PATH}/thumbnails/{thumbnail_data["thumbnail_path"]}'
		assert check_file_exists_on_storage(storage_server_path, auth_token), (
			'Thumbnail file not found on storage server'
		)

		# Clean up by removing the test entry
		client.table(settings.thumbnails_table).delete().eq('dataset_id', thumbnail_task.dataset_id).execute()
