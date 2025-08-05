import pytest
from fastapi.testclient import TestClient
from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, LicenseEnum, PlatformEnum, DatasetAccessEnum, StatusEnum

from api.src.server import app

client = TestClient(app)


# Import the test_dataset fixture
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


@pytest.fixture
def auth_headers(auth_token):
	return {'Authorization': f'Bearer {auth_token}'}


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
		json={'task_types': ['metadata'], 'priority': 5},
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


def test_priority_queue_order(test_dataset, auth_token):
	"""Test that tasks are ordered correctly by priority"""
	# Create three tasks with different priorities
	priorities = [2, 5, 1]  # Default, Highest, Lowest
	task_ids = []

	for priority in priorities:
		response = client.put(
			f'/datasets/{test_dataset}/process',
			headers={'Authorization': f'Bearer {auth_token}'},
			json={'task_types': ['metadata'], 'priority': priority},
		)
		assert response.status_code == 200
		task_ids.append(response.json()['id'])

	# Check queue positions
	with use_client(auth_token) as clientNew:
		# Order by priority DESC to match the database view's ordering
		response = clientNew.table(settings.queue_position_table).select('*').order('priority', desc=True).execute()
		tasks = response.data

		# Verify order matches priority DESC ordering from the view
		assert len(tasks) == 3
		assert tasks[0]['priority'] == 5  # Highest priority (5) comes first
		assert tasks[1]['priority'] == 2  # Default priority (2) in middle
		assert tasks[2]['priority'] == 1  # Lowest priority (1) comes last

	# Cleanup
	with use_client(auth_token) as supabaseClient:
		for task_id in task_ids:
			supabaseClient.table(settings.queue_table).delete().eq('id', task_id).execute()
