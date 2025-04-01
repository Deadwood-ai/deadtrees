import pytest
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, LabelDataEnum
from processor.src.process_deadwood_segmentation import process_deadwood_segmentation


@pytest.fixture
def deadwood_task(test_dataset_for_processing, test_processor_user):
	"""Create a test task specifically for deadwood segmentation processing"""
	return QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.deadwood],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
	)


@pytest.fixture(autouse=True)
def cleanup_labels(auth_token, deadwood_task):
	"""Fixture to clean up labels after each test"""
	yield

	# Cleanup will run after each test
	with use_client(auth_token) as client:
		# Get all labels for the dataset
		response = client.table(settings.labels_table).select('id').eq('dataset_id', deadwood_task.dataset_id).execute()

		# Delete all associated geometries and labels
		for label in response.data:
			client.table(settings.deadwood_geometries_table).delete().eq('label_id', label['id']).execute()

		client.table(settings.labels_table).delete().eq('dataset_id', deadwood_task.dataset_id).execute()


# @pytest.mark.skip(reason="Long running process - skip by default")
def test_process_deadwood_segmentation_success(deadwood_task, auth_token):
	"""Test successful deadwood segmentation processing with actual model"""
	process_deadwood_segmentation(deadwood_task, auth_token, settings.processing_path)

	with use_client(auth_token) as client:
		# Get label
		response = client.table(settings.labels_table).select('*').eq('dataset_id', deadwood_task.dataset_id).execute()
		label = response.data[0]

		# Basic label checks
		assert len(response.data) == 1
		assert label['dataset_id'] == deadwood_task.dataset_id
		assert label['label_source'] == 'model_prediction'
		assert label['label_type'] == 'semantic_segmentation'
		assert label['label_data'] == LabelDataEnum.deadwood
		assert label['label_quality'] == 3

		# Check geometries
		geom_response = (
			client.table(settings.deadwood_geometries_table).select('*').eq('label_id', label['id']).execute()
		)

		# Verify we have geometries
		assert len(geom_response.data) > 0

		# Check first geometry structure
		first_geom = geom_response.data[0]
		assert first_geom['geometry']['type'] == 'Polygon'
		assert 'coordinates' in first_geom['geometry']
