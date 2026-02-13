import pytest
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, StatusEnum
from processor.src.processor import (
	background_process, process_task, get_next_task,
	detect_crashed_stage, get_completed_stages, PIPELINE_STAGE_MAP,
)


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
				'task_types': [TaskTypeEnum.metadata],
				'priority': 1,
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
		assert status['is_metadata_done'] is True
		assert not status['has_error']


def test_background_process_no_tasks():
	"""Test background process behavior when no tasks are in queue"""
	# Run the background process with empty queue
	background_process()

	# Verify it completes without error
	# (The function should return None when no tasks are found)
	assert background_process() is None


@pytest.fixture
def sequential_task(test_dataset_for_processing, test_processor_user):
	"""Create a test task for sequential processing"""
	return QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[
			TaskTypeEnum.geotiff,
			TaskTypeEnum.cog,
			TaskTypeEnum.thumbnail,
			TaskTypeEnum.metadata,
			TaskTypeEnum.deadwood,
		],
		priority=1,
		is_processing=False,  # Column still exists in DB but is inert
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
			client.table(settings.orthos_processed_table)
			.select('*')
			.eq('dataset_id', sequential_task.dataset_id)
			.execute()
		)
		assert len(ortho_response.data) == 1
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
		assert 'biome' in metadata_response.data[0]['metadata']

		# Check deadwood processing
		deadwood_response = (
			client.table(settings.labels_table).select('*').eq('dataset_id', sequential_task.dataset_id).execute()
		)
		assert len(deadwood_response.data) == 1

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
		assert status['is_deadwood_done'] is True

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


@pytest.fixture
def processor_task_with_missing_file(test_processor_user, auth_token):
	"""Create a test task with a non-existent dataset file"""
	task_id = None
	try:
		# Create a dataset entry that points to a non-existent file
		with use_client(auth_token) as client:
			# First create dataset
			dataset_data = {
				'file_name': 'non_existent_file.tif',
				'user_id': test_processor_user,
				'license': 'CC BY',
				'platform': 'drone',
				'authors': ['Test Author'],
				'data_access': 'public',
				'aquisition_year': 2024,
				'aquisition_month': 1,
				'aquisition_day': 1,
			}
			dataset_response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = dataset_response.data[0]['id']

			# Create status entry
			status_data = {
				'dataset_id': dataset_id,
				'is_upload_done': True,
				'current_status': StatusEnum.idle,
			}
			client.table(settings.statuses_table).insert(status_data).execute()

			# Create test task in queue
			task_data = {
				'dataset_id': dataset_id,
				'user_id': test_processor_user,
				'task_types': [TaskTypeEnum.metadata],
				'priority': 1,
			}
			response = client.table(settings.queue_table).insert(task_data).execute()
			task_id = response.data[0]['id']

			yield task_id

	finally:
		# Cleanup
		if task_id:
			with use_client(auth_token) as client:
				# Get dataset_id before deleting task
				task_response = client.table(settings.queue_table).select('dataset_id').eq('id', task_id).execute()
				dataset_id = task_response.data[0]['dataset_id'] if task_response.data else None

				# Delete task
				client.table(settings.queue_table).delete().eq('id', task_id).execute()

				if dataset_id:
					# Delete status and dataset
					client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
					client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_failed_process_removes_task_from_queue(processor_task_with_missing_file, auth_token):
	"""Test that failed processing removes task from queue but records error in status.

	This prevents endless retry loops - the error is recorded in v2_statuses
	so users can see what failed, but the task doesn't block the queue.
	"""
	# First verify task exists before processing
	with use_client(auth_token) as client:
		initial_task = (
			client.table(settings.queue_table).select('*').eq('id', processor_task_with_missing_file).execute()
		)
		dataset_id = initial_task.data[0]['dataset_id']

	try:
		# Run the background process - this should raise a ProcessingError
		background_process()
	except Exception:
		# We expect an error
		pass

	# Verify task state after failed processing
	with use_client(auth_token) as client:
		# Task should be REMOVED from queue (prevents endless retry loop)
		queue_response = (
			client.table(settings.queue_table).select('*').eq('id', processor_task_with_missing_file).execute()
		)
		assert len(queue_response.data) == 0, 'Failed task should be removed from queue'

		# Check status was updated to reflect error
		status_response = client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute()
		assert len(status_response.data) == 1
		status = status_response.data[0]

		# Verify error is recorded in status table
		assert status['has_error'] is True, 'Status should have has_error=True'
		assert status['error_message'] is not None, 'Error message should be recorded'


def test_processor_respects_priority(test_dataset_for_processing, test_processor_user, auth_token):
	"""Test that processor picks highest priority task first"""
	task_ids = []
	try:
		# Create two tasks with different priorities
		with use_client(auth_token) as client:
			# Create lower priority task first
			task1_data = {
				'dataset_id': test_dataset_for_processing,
				'user_id': test_processor_user,
				'task_types': [TaskTypeEnum.metadata],
				'priority': 2,  # Lower priority
			}
			response = client.table(settings.queue_table).insert(task1_data).execute()
			task_ids.append(response.data[0]['id'])

			# Create higher priority task second
			task2_data = {
				'dataset_id': test_dataset_for_processing,
				'user_id': test_processor_user,
				'task_types': [TaskTypeEnum.metadata],
				'priority': 5,  # Higher priority (changed from 1)
			}
			response = client.table(settings.queue_table).insert(task2_data).execute()
			task_ids.append(response.data[0]['id'])

		# Get next task
		next_task = get_next_task(auth_token)

		# Verify the higher priority task (priority=5) is selected first
		assert next_task is not None
		assert next_task.priority == 5  # Changed from 1 to 5

	finally:
		# Cleanup
		with use_client(auth_token) as client:
			for task_id in task_ids:
				client.table(settings.queue_table).delete().eq('id', task_id).execute()


# --- Crash detection unit tests ---

def test_detect_crashed_stage_finds_first_incomplete():
	"""Test that detect_crashed_stage returns the first incomplete stage in the pipeline."""
	status_data = {
		'is_odm_done': True,
		'is_ortho_done': True,
		'is_metadata_done': True,
		'is_cog_done': False,
		'is_thumbnail_done': False,
		'is_deadwood_done': False,
		'is_forest_cover_done': False,
	}
	task_types = [
		TaskTypeEnum.geotiff, TaskTypeEnum.metadata, TaskTypeEnum.cog,
		TaskTypeEnum.thumbnail, TaskTypeEnum.deadwood, TaskTypeEnum.treecover,
	]
	assert detect_crashed_stage(status_data, task_types) == 'cog_processing'


def test_detect_crashed_stage_only_checks_requested_types():
	"""Test that detect_crashed_stage only considers task types that were actually requested."""
	status_data = {
		'is_ortho_done': True,
		'is_metadata_done': True,
		'is_cog_done': True,
		'is_thumbnail_done': True,
		'is_deadwood_done': False,  # Not done, but not requested
		'is_forest_cover_done': False,
	}
	# Only requesting up to thumbnail -- deadwood/treecover not in the list
	task_types = [TaskTypeEnum.geotiff, TaskTypeEnum.metadata, TaskTypeEnum.cog, TaskTypeEnum.thumbnail]
	assert detect_crashed_stage(status_data, task_types) == 'unknown'


def test_detect_crashed_stage_deadwood():
	"""Test crash detection specifically for deadwood segmentation crash."""
	status_data = {
		'is_ortho_done': True,
		'is_metadata_done': True,
		'is_cog_done': True,
		'is_thumbnail_done': True,
		'is_deadwood_done': False,  # Crashed here
		'is_forest_cover_done': False,
		'current_status': 'deadwood_segmentation',
	}
	task_types = [
		TaskTypeEnum.geotiff, TaskTypeEnum.metadata, TaskTypeEnum.cog,
		TaskTypeEnum.thumbnail, TaskTypeEnum.deadwood, TaskTypeEnum.treecover,
	]
	assert detect_crashed_stage(status_data, task_types) == 'deadwood_segmentation'


def test_get_completed_stages():
	"""Test that get_completed_stages returns all completed stages."""
	status_data = {
		'is_odm_done': False,
		'is_ortho_done': True,
		'is_metadata_done': True,
		'is_cog_done': True,
		'is_thumbnail_done': True,
		'is_deadwood_done': False,
		'is_forest_cover_done': False,
	}
	completed = get_completed_stages(status_data)
	assert 'ortho_processing' in completed
	assert 'metadata_processing' in completed
	assert 'cog_processing' in completed
	assert 'thumbnail_processing' in completed
	assert 'deadwood_segmentation' not in completed
	assert 'forest_cover_segmentation' not in completed


def test_get_completed_stages_none_completed():
	"""Test get_completed_stages when nothing has completed."""
	status_data = {}
	completed = get_completed_stages(status_data)
	assert completed == []


@pytest.fixture
def crashed_dataset_task(test_processor_user, auth_token):
	"""Create a task that simulates a previous crash (current_status stuck, some stages done)."""
	task_id = None
	dataset_id = None
	try:
		with use_client(auth_token) as client:
			# Create dataset
			dataset_data = {
				'file_name': 'crash_test_file.tif',
				'user_id': test_processor_user,
				'license': 'CC BY',
				'platform': 'drone',
				'authors': ['Test Author'],
				'data_access': 'public',
				'aquisition_year': 2024,
				'aquisition_month': 1,
				'aquisition_day': 1,
			}
			dataset_response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = dataset_response.data[0]['id']

			# Create status entry that simulates a crash during deadwood segmentation
			status_data = {
				'dataset_id': dataset_id,
				'is_upload_done': True,
				'current_status': 'deadwood_segmentation',  # Stuck in non-idle state
				'is_ortho_done': True,
				'is_metadata_done': True,
				'is_cog_done': True,
				'is_thumbnail_done': True,
				'is_deadwood_done': False,  # Crashed before completing
				'is_forest_cover_done': False,
				'has_error': False,
			}
			client.table(settings.statuses_table).insert(status_data).execute()

			# Create queue task
			task_data = {
				'dataset_id': dataset_id,
				'user_id': test_processor_user,
				'task_types': [
					TaskTypeEnum.geotiff, TaskTypeEnum.metadata, TaskTypeEnum.cog,
					TaskTypeEnum.thumbnail, TaskTypeEnum.deadwood, TaskTypeEnum.treecover,
				],
				'priority': 1,
			}
			response = client.table(settings.queue_table).insert(task_data).execute()
			task_id = response.data[0]['id']

			yield {'task_id': task_id, 'dataset_id': dataset_id}

	finally:
		if auth_token:
			with use_client(auth_token) as client:
				if task_id:
					client.table(settings.queue_table).delete().eq('id', task_id).execute()
				if dataset_id:
					client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
					client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_background_process_detects_crashed_dataset(crashed_dataset_task, auth_token):
	"""Test that background_process detects a crashed dataset, marks it as errored,
	and removes it from the queue."""
	dataset_id = crashed_dataset_task['dataset_id']

	# Run the background process -- should detect the crash and clear it
	background_process()

	with use_client(auth_token) as client:
		# Task should be removed from queue
		queue_response = (
			client.table(settings.queue_table).select('*')
			.eq('id', crashed_dataset_task['task_id']).execute()
		)
		assert len(queue_response.data) == 0, 'Crashed task should be removed from queue'

		# Status should be marked as errored with current_status back to idle
		status_response = (
			client.table(settings.statuses_table).select('*')
			.eq('dataset_id', dataset_id).execute()
		)
		assert len(status_response.data) == 1
		status = status_response.data[0]
		assert status['has_error'] is True, 'Status should have has_error=True'
		assert status['current_status'] == 'idle', 'Status should be reset to idle'
		assert 'deadwood_segmentation' in status['error_message'], 'Error should mention crashed stage'
