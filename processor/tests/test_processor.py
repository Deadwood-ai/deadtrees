import pytest
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, StatusEnum
from processor.src.processor import background_process


@pytest.fixture
def processor_task(test_dataset_for_processing, test_processor_user, auth_token):
	"""Create a test task for processor testing"""
	task_id = None
	try:
		# Create test task in queue
		with use_client(auth_token) as client:
			task_data = {
				'dataset_id': test_dataset_for_processing,
				'user_id': test_processor_user,
				'task_types': [TaskTypeEnum.thumbnail],
				'priority': 1,
				'is_processing': False,
			}
			response = client.table(settings.queue_table).insert(task_data).execute()
			task_id = response.data[0]['id']

			yield task_id

	finally:
		# Cleanup
		if task_id:
			with use_client(auth_token) as client:
				client.table(settings.queue_table).delete().eq('id', task_id).execute()


def test_background_process_success(processor_task, auth_token, test_dataset_for_processing):
	"""Test successful background processing of a task"""
	# Run the background process
	background_process()

	# Verify task was processed and removed from queue
	with use_client(auth_token) as client:
		# Check queue is empty
		queue_response = client.table(settings.queue_table).select('*').eq('id', processor_task).execute()
		assert len(queue_response.data) == 0

		# Check status was updated
		status_response = (
			client.table(settings.statuses_table).select('*').eq('dataset_id', test_dataset_for_processing).execute()
		)
		assert len(status_response.data) == 1
		status = status_response.data[0]

		# Verify status updates
		assert status['current_status'] == StatusEnum.idle
		assert status['is_thumbnail_done'] is True
		assert not status['has_error']


def test_background_process_no_tasks():
	"""Test background process behavior when no tasks are in queue"""
	# Run the background process with empty queue
	background_process()

	# Verify it completes without error
	# (The function should return None when no tasks are found)
	assert background_process() is None


def test_background_process_max_concurrent(processor_task, auth_token):
	"""Test background process respects max concurrent tasks limit"""
	# Set a task as currently processing
	with use_client(auth_token) as client:
		client.table(settings.queue_table).update({'is_processing': True}).eq('id', processor_task).execute()

	# Set CONCURRENT_TASKS to 1 temporarily
	original_limit = settings.CONCURRENT_TASKS
	settings.CONCURRENT_TASKS = 1

	try:
		# Run background process
		background_process()

		# Verify no new tasks were started
		with use_client(auth_token) as client:
			response = client.table(settings.queue_table).select('*').execute()
			processing_tasks = [task for task in response.data if task['is_processing']]
			assert len(processing_tasks) == 1

	finally:
		# Restore original concurrent tasks limit
		settings.CONCURRENT_TASKS = original_limit
