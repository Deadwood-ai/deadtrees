import pytest
from fastapi.testclient import TestClient

from api.src.server import app
from shared.db import use_client, login
from shared.settings import settings
from shared.models import TaskTypeEnum, LicenseEnum, PlatformEnum, DatasetAccessEnum, StatusEnum

client = TestClient(app)


@pytest.fixture(scope='function')
def test_dataset(auth_token, test_user):
	"""Create a temporary test dataset for process testing"""
	dataset_id = None

	try:
		# Create test dataset
		with use_client(auth_token) as supabaseClient:
			# Create dataset
			dataset_data = {
				'file_name': 'test-process.tif',
				'user_id': test_user,
				'license': LicenseEnum.cc_by,
				'platform': PlatformEnum.drone,
				'authors': ['Test Author'],
				'data_access': DatasetAccessEnum.public,
				'aquisition_year': 2024,
				'aquisition_month': 1,
				'aquisition_day': 1,
			}
			response = supabaseClient.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = response.data[0]['id']

			# Create initial status entry
			status_data = {
				'dataset_id': dataset_id,
				'is_upload_done': True,  # Set to True so processing can begin
				'current_status': StatusEnum.idle,
			}
			supabaseClient.table(settings.statuses_table).insert(status_data).execute()

			yield dataset_id

	finally:
		# Ensure cleanup happens even if tests fail
		if dataset_id:
			with use_client(auth_token) as supabaseClient:
				# Delete from queue table first (this will cascade to queue_positions view)
				supabaseClient.table(settings.queue_table).delete().eq('dataset_id', dataset_id).execute()
				# Delete the status entry
				supabaseClient.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				# Delete the dataset
				supabaseClient.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_create_processing_task(test_dataset, auth_token):
	"""Test creating a new processing task for a dataset"""
	response = client.put(
		f'/datasets/{test_dataset}/process',
		json={'task_types': ['cog', 'thumbnail']},
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	assert response.status_code == 200
	data = response.json()

	assert data['dataset_id'] == test_dataset
	assert 'cog' in data['task_types']
	assert 'thumbnail' in data['task_types']
	assert not data['is_processing']

	with use_client(auth_token) as supabaseClient:
		response = supabaseClient.table(settings.queue_table).select('*').eq('dataset_id', test_dataset).execute()
		assert len(response.data) == 1
		assert response.data[0]['dataset_id'] == test_dataset
		assert 'cog' in response.data[0]['task_types']
		assert 'thumbnail' in response.data[0]['task_types']


def test_create_processing_task_unauthorized(test_dataset):
	"""Test process creation without authentication"""
	response = client.put(
		f'/datasets/{test_dataset}/process',
		params={'task_types': ['cog', 'thumbnail']},
		headers={},
	)
	assert response.status_code == 401


def test_create_processing_task_invalid_dataset(auth_token):
	"""Test process creation for non-existent dataset"""
	response = client.put(
		'/datasets/99999/process',
		json={'task_types': ['cog', 'thumbnail']},
		headers={'Authorization': f'Bearer {auth_token}'},
	)
	assert response.status_code == 404


def test_create_processing_task_empty_types(test_dataset, auth_token):
	"""Test creating a task with empty task types list"""
	response = client.put(
		f'/datasets/{test_dataset}/process',
		json={'task_types': []},
		headers={'Authorization': f'Bearer {auth_token}'},
	)
	assert response.status_code == 400


# Priority tests added from test_process_priority.py
def test_process_default_priority(test_dataset, auth_token):
	"""Test that process request uses default priority (2) when none specified"""
	response = client.put(
		f'/datasets/{test_dataset}/process',
		headers={'Authorization': f'Bearer {auth_token}'},
		json={'task_types': ['metadata']},
	)
	assert response.status_code == 200
	data = response.json()
	assert data['priority'] == 2


def test_process_custom_priority(test_dataset, auth_token):
	"""Test that process request accepts custom priority"""
	response = client.put(
		f'/datasets/{test_dataset}/process',
		headers={'Authorization': f'Bearer {auth_token}'},
		json={'task_types': ['metadata'], 'priority': 5},  # Higher priority (5)
	)
	assert response.status_code == 200
	data = response.json()
	assert data['priority'] == 5


def test_process_invalid_priority(test_dataset, auth_token):
	"""Test that process request rejects invalid priority values"""
	response = client.put(
		f'/datasets/{test_dataset}/process',
		headers={'Authorization': f'Bearer {auth_token}'},
		json={
			'task_types': ['metadata'],
			'priority': 0,  # Invalid priority
		},
	)
	assert response.status_code == 422  # Validation error


def test_priority_queue_order(auth_token, test_user):
	"""Test that tasks are ordered correctly by priority (higher numbers = higher priority)"""
	# Create three datasets with different priorities
	# Note: Each dataset can only have one queue entry, so we need 3 separate datasets
	priorities = [2, 5, 1]  # Default, Highest, Lowest
	task_ids = []
	dataset_ids = []

	try:
		# Create 3 test datasets
		with use_client(auth_token) as supabaseClient:
			for i, priority in enumerate(priorities):
				# Create test dataset
				dataset_data = {
					'user_id': test_user,
					'license': LicenseEnum.cc_by.value,
					'platform': PlatformEnum.drone.value,
					'data_access': DatasetAccessEnum.public.value,
					'authors': ['test_author'],
					'file_name': f'test_priority_{i}.zip',  # Required field
				}
				dataset_response = supabaseClient.table(settings.datasets_table).insert(dataset_data).execute()
				dataset_id = dataset_response.data[0]['id']
				dataset_ids.append(dataset_id)

				# Create status entry
				status_data = {'dataset_id': dataset_id}
				supabaseClient.table(settings.statuses_table).insert(status_data).execute()

				# Create queue task with specific priority
				response = client.put(
					f'/datasets/{dataset_id}/process',
					headers={'Authorization': f'Bearer {auth_token}'},
					json={'task_types': ['metadata'], 'priority': priority},
				)
				assert response.status_code == 200
				task_ids.append(response.json()['id'])

		# Check queue positions across all datasets
		with use_client(auth_token) as clientNew:
			# Order by priority DESC to match the database view's ordering
			# Filter by our test dataset IDs
			response = (
				clientNew.table(settings.queue_position_table)
				.select('*')
				.in_('dataset_id', dataset_ids)
				.order('priority', desc=True)
				.execute()
			)
			tasks = response.data

			# Verify order matches priority DESC ordering from the view
			assert len(tasks) == 3
			assert tasks[0]['priority'] == 5  # Highest priority (5) comes first
			assert tasks[1]['priority'] == 2  # Default priority (2) in middle
			assert tasks[2]['priority'] == 1  # Lowest priority (1) comes last

	finally:
		# Cleanup datasets (cascade deletes queue items and status entries)
		with use_client(auth_token) as supabaseClient:
			for dataset_id in dataset_ids:
				supabaseClient.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_rerun_removes_old_queue_items(test_dataset, auth_token):
	"""Test that rerunning a dataset removes old queue items"""
	# Create initial task
	response = client.put(
		f'/datasets/{test_dataset}/process',
		json={'task_types': ['cog', 'thumbnail'], 'priority': 2},
		headers={'Authorization': f'Bearer {auth_token}'},
	)
	assert response.status_code == 200
	first_task_id = response.json()['id']

	# Verify task exists in queue
	with use_client(auth_token) as supabaseClient:
		response = supabaseClient.table(settings.queue_table).select('*').eq('dataset_id', test_dataset).execute()
		assert len(response.data) == 1
		assert response.data[0]['id'] == first_task_id

	# Rerun the same dataset (should remove old task)
	response = client.put(
		f'/datasets/{test_dataset}/process',
		json={'task_types': ['metadata'], 'priority': 1},
		headers={'Authorization': f'Bearer {auth_token}'},
	)
	assert response.status_code == 200
	second_task_id = response.json()['id']

	# Verify only new task exists, old one was removed
	with use_client(auth_token) as supabaseClient:
		response = supabaseClient.table(settings.queue_table).select('*').eq('dataset_id', test_dataset).execute()
		assert len(response.data) == 1
		assert response.data[0]['id'] == second_task_id
		assert response.data[0]['id'] != first_task_id
		assert 'metadata' in response.data[0]['task_types']
		assert response.data[0]['priority'] == 1


def test_rerun_blocks_active_processing(test_dataset, auth_token, test_user):
	"""Test that rerunning a dataset that's actively processing returns 409 Conflict"""
	# Instead of creating via API then updating, directly insert a queue item with is_processing=True
	# This simulates what the processor does when it picks up a task
	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
	task_id = None
	with use_client(auth_token) as supabaseClient:
		task_data = {
			'dataset_id': test_dataset,
			'user_id': test_user,
			'task_types': ['cog', 'thumbnail'],
			'priority': 2,
			'is_processing': True,  # Already being processed
		}
		response = supabaseClient.table(settings.queue_table).insert(task_data).execute()
		task_id = response.data[0]['id']

	# Try to rerun while processing (should fail with 409)
	response = client.put(
		f'/datasets/{test_dataset}/process',
		json={'task_types': ['metadata']},
		headers={'Authorization': f'Bearer {auth_token}'},
	)
	assert response.status_code == 409
	assert 'currently being processed' in response.json()['detail']
	assert 'stop the active processing container' in response.json()['detail'].lower()

	# Verify old task is still there and unchanged
	with use_client(auth_token) as supabaseClient:
		response = supabaseClient.table(settings.queue_table).select('*').eq('dataset_id', test_dataset).execute()
		assert len(response.data) == 1
		assert response.data[0]['id'] == task_id
		assert response.data[0]['is_processing'] is True


def test_rerun_succeeds_after_failed_processing(test_dataset, auth_token):
	"""Test that a dataset can be successfully rerun after failed processing"""
	# Create initial task
	response = client.put(
		f'/datasets/{test_dataset}/process',
		json={'task_types': ['cog']},
		headers={'Authorization': f'Bearer {auth_token}'},
	)
	assert response.status_code == 200
	first_task_id = response.json()['id']

	# Simulate failed processing: task exists but is_processing=False (simulating completion/failure)
	with use_client(auth_token) as supabaseClient:
		# Update status to indicate error
		supabaseClient.table(settings.statuses_table).update(
			{
				'has_error': True,
				'error_message': 'Simulated processing failure',
				'current_status': StatusEnum.idle,
			}
		).eq('dataset_id', test_dataset).execute()

	# Rerun should succeed (removes old task, adds new one)
	response = client.put(
		f'/datasets/{test_dataset}/process',
		json={'task_types': ['cog', 'thumbnail', 'metadata'], 'priority': 1},
		headers={'Authorization': f'Bearer {auth_token}'},
	)
	assert response.status_code == 200
	second_task_id = response.json()['id']
	assert second_task_id != first_task_id

	# Verify new task is in queue with correct task types
	with use_client(auth_token) as supabaseClient:
		response = supabaseClient.table(settings.queue_table).select('*').eq('dataset_id', test_dataset).execute()
		assert len(response.data) == 1
		assert response.data[0]['id'] == second_task_id
		assert 'cog' in response.data[0]['task_types']
		assert 'thumbnail' in response.data[0]['task_types']
		assert 'metadata' in response.data[0]['task_types']
		assert response.data[0]['priority'] == 1
		assert response.data[0]['is_processing'] is False


def test_rerun_multiple_old_queue_items(test_dataset, auth_token, test_user):
	"""Test that rerunning removes multiple old queue items for the same dataset"""
	# Create multiple tasks manually (simulating duplicate entries)
	# Note: Direct queue manipulation requires authenticated user context
	task_ids = []
	with use_client(auth_token) as supabaseClient:
		for i in range(3):
			task_data = {
				'dataset_id': test_dataset,
				'user_id': test_user,  # Use test_user fixture instead of auth call
				'task_types': ['cog'],
				'priority': 2,
				'is_processing': False,
			}
			response = supabaseClient.table(settings.queue_table).insert(task_data).execute()
			task_ids.append(response.data[0]['id'])

	# Verify all 3 tasks exist
	with use_client(auth_token) as supabaseClient:
		response = supabaseClient.table(settings.queue_table).select('*').eq('dataset_id', test_dataset).execute()
		assert len(response.data) == 3

	# Rerun should remove all old tasks and add one new one
	response = client.put(
		f'/datasets/{test_dataset}/process',
		json={'task_types': ['metadata']},
		headers={'Authorization': f'Bearer {auth_token}'},
	)
	assert response.status_code == 200
	new_task_id = response.json()['id']

	# Verify only new task exists
	with use_client(auth_token) as supabaseClient:
		response = supabaseClient.table(settings.queue_table).select('*').eq('dataset_id', test_dataset).execute()
		assert len(response.data) == 1
		assert response.data[0]['id'] == new_task_id
		assert response.data[0]['id'] not in task_ids
