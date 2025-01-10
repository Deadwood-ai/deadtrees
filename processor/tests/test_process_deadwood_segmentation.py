import pytest

pytestmark = pytest.mark.skip(reason='Skip all segmentations, since integration is in progress')
from pathlib import Path

from conftest import DATASET_ID
from shared.supabase import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask
from processor.src.process_deadwood_segmentation import process_deadwood_segmentation


@pytest.fixture
def deadwood_task(patch_test_file):
	"""Create a test task specifically for deadwood segmentation processing"""
	return QueueTask(
		id=1,
		dataset_id=DATASET_ID,
		user_id='484d53be-2fee-4449-ad36-a6b083aab663',
		task_type=TaskTypeEnum.deadwood_segmentation,
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={},
	)


@pytest.fixture(autouse=True)
def cleanup_labels(auth_token, deadwood_task):
	"""Fixture to clean up labels after each test"""
	yield

	# Cleanup will run after each test
	with use_client(auth_token) as client:
		client.table(settings.labels_table).delete().eq('dataset_id', deadwood_task.dataset_id).execute()


def test_process_deadwood_segmentation_success(deadwood_task, auth_token):
	"""Test successful deadwood segmentation processing with actual model"""
	process_deadwood_segmentation(deadwood_task, auth_token, settings.processing_path)

	with use_client(auth_token) as client:
		response = client.table(settings.labels_table).select('*').eq('dataset_id', deadwood_task.dataset_id).execute()
		data = response.data[0]

		# Basic response checks
		assert len(response.data) == 1
		assert data['dataset_id'] == deadwood_task.dataset_id

		# Check label structure
		assert 'label' in data
		assert data['label']['type'] == 'MultiPolygon'
		assert 'coordinates' in data['label']
		assert len(data['label']['coordinates']) > 0  # Should have actual predictions

		# Check AOI structure
		assert 'aoi' in data
		assert data['aoi']['type'] == 'MultiPolygon'
		assert 'coordinates' in data['aoi']

		# Check metadata
		assert data['label_type'] == 'segmentation'
		assert data['label_source'] == 'model_prediction'
		assert data['label_quality'] == 3


def test_process_deadwood_segmentation_invalid_file(deadwood_task, auth_token):
	"""Test handling of invalid input file"""
	deadwood_task.dataset_id = 'nonexistent_id'

	with pytest.raises(Exception) as exc_info:
		process_deadwood_segmentation(deadwood_task, auth_token, settings.processing_path)

	assert 'Error fetching dataset' in str(exc_info.value)
