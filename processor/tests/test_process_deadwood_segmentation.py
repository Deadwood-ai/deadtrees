import pytest
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, LabelDataEnum, LabelSourceEnum, LabelTypeEnum
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
		assert label['label_source'] == LabelSourceEnum.model_prediction.value
		assert label['label_type'] == LabelTypeEnum.semantic_segmentation.value
		assert label['label_data'] == LabelDataEnum.deadwood.value
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


def test_process_deadwood_segmentation_replaces_existing_labels(deadwood_task, auth_token):
	"""Test that running deadwood segmentation replaces existing model prediction labels"""
	from shared.models import LabelPayloadData, LabelSourceEnum, LabelTypeEnum, LabelDataEnum
	from shared.labels import create_label_with_geometries
	from shapely.geometry import Polygon

	# Create a simple test polygon
	test_polygon = Polygon([(0, 0), (0, 1), (1, 1), (1, 0), (0, 0)])

	# Create a GeoJSON MultiPolygon from the test polygon
	test_geojson = {
		'type': 'MultiPolygon',
		'coordinates': [[[[float(x), float(y)] for x, y in test_polygon.exterior.coords]]],
	}

	# Create a test label payload for existing model prediction
	existing_payload = LabelPayloadData(
		dataset_id=deadwood_task.dataset_id,
		label_source=LabelSourceEnum.model_prediction.value,
		label_type=LabelTypeEnum.semantic_segmentation.value,
		label_data=LabelDataEnum.deadwood.value,
		label_quality=3,
		geometry=test_geojson,
		properties={'source': 'test_existing_prediction'},
	)

	# Create existing label
	existing_label = create_label_with_geometries(existing_payload, deadwood_task.user_id, auth_token)

	# Verify the existing label was created
	with use_client(auth_token) as client:
		response = client.table(settings.labels_table).select('*').eq('dataset_id', deadwood_task.dataset_id).execute()
		assert len(response.data) == 1
		assert response.data[0]['id'] == existing_label.id

		# Verify geometries were created for the existing label
		geom_response = (
			client.table(settings.deadwood_geometries_table).select('*').eq('label_id', existing_label.id).execute()
		)
		assert len(geom_response.data) > 0

	# Run deadwood segmentation process
	process_deadwood_segmentation(deadwood_task, auth_token, settings.processing_path)

	# Verify the results
	with use_client(auth_token) as client:
		# Get all labels for the dataset
		response = client.table(settings.labels_table).select('*').eq('dataset_id', deadwood_task.dataset_id).execute()

		# Should only be one label (the new one)
		assert len(response.data) == 1

		# Verify it's not the old label
		new_label_id = response.data[0]['id']
		assert new_label_id != existing_label.id

		# Verify it has the right properties
		label = response.data[0]
		assert label['dataset_id'] == deadwood_task.dataset_id
		assert label['label_source'] == LabelSourceEnum.model_prediction.value
		assert label['label_type'] == LabelTypeEnum.semantic_segmentation.value
		assert label['label_data'] == LabelDataEnum.deadwood.value
		assert label['label_quality'] == 3

		# Verify old geometries are gone
		old_geom_response = (
			client.table(settings.deadwood_geometries_table).select('*').eq('label_id', existing_label.id).execute()
		)
		assert len(old_geom_response.data) == 0

		# Verify new geometries exist
		new_geom_response = (
			client.table(settings.deadwood_geometries_table).select('*').eq('label_id', new_label_id).execute()
		)
		assert len(new_geom_response.data) > 0
