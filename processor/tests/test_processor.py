import pytest
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, StatusEnum
from processor.src.processor import background_process, process_task


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


@pytest.fixture
def sequential_task(test_dataset_for_processing, test_processor_user):
	"""Create a test task for sequential processing"""
	return QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.geotiff, TaskTypeEnum.cog, TaskTypeEnum.thumbnail, TaskTypeEnum.metadata],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
	)


def test_sequential_processing(sequential_task, auth_token):
	"""Test running all processing steps sequentially"""
	# Process all tasks
	process_task(sequential_task, auth_token)

	# Verify results in database
	with use_client(auth_token) as client:
		# Check GeoTIFF processing
		ortho_response = (
			client.table(settings.orthos_table).select('*').eq('dataset_id', sequential_task.dataset_id).execute()
		)
		assert len(ortho_response.data) == 1
		assert ortho_response.data[0]['ortho_processed'] is True
		assert ortho_response.data[0]['ortho_processing_runtime'] > 0

		# Check COG processing
		cog_response = (
			client.table(settings.cogs_table).select('*').eq('dataset_id', sequential_task.dataset_id).execute()
		)
		assert len(cog_response.data) == 1
		assert cog_response.data[0]['cog_file_size'] > 0
		assert cog_response.data[0]['cog_info'] is not None

		# Check thumbnail processing
		thumbnail_response = (
			client.table(settings.thumbnails_table).select('*').eq('dataset_id', sequential_task.dataset_id).execute()
		)
		assert len(thumbnail_response.data) == 1
		assert thumbnail_response.data[0]['thumbnail_file_size'] > 0
		assert thumbnail_response.data[0]['thumbnail_processing_runtime'] > 0

		# Check metadata processing
		metadata_response = (
			client.table(settings.metadata_table).select('*').eq('dataset_id', sequential_task.dataset_id).execute()
		)
		assert len(metadata_response.data) == 1
		assert metadata_response.data[0]['processing_runtime'] > 0
		assert 'gadm' in metadata_response.data[0]['metadata']

		# Verify final status
		status_response = (
			client.table(settings.statuses_table).select('*').eq('dataset_id', sequential_task.dataset_id).execute()
		)
		assert len(status_response.data) == 1
		status = status_response.data[0]
		assert status['current_status'] == StatusEnum.idle
		assert status['is_ortho_done'] is True
		assert status['is_cog_done'] is True
		assert status['is_thumbnail_done'] is True
		assert status['is_metadata_done'] is True
		assert not status['has_error']

		# Verify task was removed from queue
		queue_response = client.table(settings.queue_table).select('*').eq('id', sequential_task.id).execute()
		assert len(queue_response.data) == 0


@pytest.fixture(autouse=True)
def cleanup_storage():
	"""Clean up storage before and after each test"""
	# Setup
	storage_path = Path('/data/archive')
	processing_path = Path('/data/processing_dir')

	def clean_directory(path: Path):
		if path.exists():
			for file in path.glob('*'):
				try:
					if file.is_file():
						file.unlink()
				except Exception:
					pass

	# Clean before test
	clean_directory(storage_path)
	clean_directory(processing_path)

	yield

	# Clean after test
	clean_directory(storage_path)
	clean_directory(processing_path)
