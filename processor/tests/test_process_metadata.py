import pytest
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, MetadataType
from processor.src.process_metadata import process_metadata


@pytest.fixture
def metadata_task(test_dataset_for_processing, test_processor_user):
	"""Create a test task for metadata processing"""
	return QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.metadata],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={},
	)


def test_process_metadata_success(metadata_task, auth_token):
	"""Test successful metadata processing"""
	process_metadata(metadata_task, settings.processing_path)

	with use_client(auth_token) as client:
		response = (
			client.table(settings.metadata_table).select('*').eq('dataset_id', metadata_task.dataset_id).execute()
		)

		assert len(response.data) == 1
		metadata = response.data[0]

		# Verify metadata structure
		assert metadata['dataset_id'] == metadata_task.dataset_id
		assert isinstance(metadata['metadata'], dict)
		assert MetadataType.GADM in metadata['metadata']

		# Verify GADM metadata
		gadm_metadata = metadata['metadata'][MetadataType.GADM]
		assert isinstance(gadm_metadata, dict)
		assert 'admin_level_1' in gadm_metadata
		assert 'admin_level_2' in gadm_metadata
		assert 'admin_level_3' in gadm_metadata
		assert gadm_metadata['source'] == 'GADM'
		assert gadm_metadata['version'] == '4.1.0'

		# Verify other fields
		assert 'version' in metadata
		assert metadata['processing_runtime'] > 0

		# Clean up
		client.table(settings.metadata_table).delete().eq('dataset_id', metadata_task.dataset_id).execute()
