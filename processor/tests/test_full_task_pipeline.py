"""End-to-end run of the production reprocessing task list through the worker loop.

Needs the local Supabase + storage stack, model checkpoints and (for realistic
runtimes) a GPU, so it only runs in the processing-server validation lane.
"""

from pathlib import Path

import pytest

import processor.src.process_geotiff as process_geotiff_module
import processor.src.utils.local_ortho as local_ortho_module
from processor.src.processor import background_process
from processor.src.utils.drain_control import BackgroundProcessResult
from shared.db import use_client
from shared.models import LabelDataEnum, TaskTypeEnum
from shared.settings import settings

pytestmark = [pytest.mark.slow, pytest.mark.comprehensive]

@pytest.fixture
def test_file():
	"""The full fixture ortho, so every model (TCD included) sees real, non-empty tiles."""
	return Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'test-data.tif'


PRODUCTION_TASK_TYPES = [
	TaskTypeEnum.geotiff,
	TaskTypeEnum.cog,
	TaskTypeEnum.thumbnail,
	TaskTypeEnum.metadata,
	TaskTypeEnum.aoi_v1,
	TaskTypeEnum.deadwood_v1,
	TaskTypeEnum.treecover_v1,
	TaskTypeEnum.deadwood_treecover_combined_v2,
	TaskTypeEnum.embeddings_v1,
]


def test_production_task_list_runs_end_to_end(test_dataset_for_processing, test_processor_user, auth_token, monkeypatch):
	dataset_id = test_dataset_for_processing
	pulls = []

	def counting_pull(original):
		def pull(remote_path, local_path, token, pull_dataset_id):
			pulls.append(remote_path)
			return original(remote_path, local_path, token, pull_dataset_id)

		return pull

	monkeypatch.setattr(
		process_geotiff_module,
		'pull_file_from_storage_server',
		counting_pull(process_geotiff_module.pull_file_from_storage_server),
	)
	monkeypatch.setattr(
		local_ortho_module,
		'pull_file_from_storage_server',
		counting_pull(local_ortho_module.pull_file_from_storage_server),
	)

	with use_client(auth_token) as client:
		queued = (
			client.table(settings.queue_table)
			.insert(
				{
					'dataset_id': dataset_id,
					'user_id': test_processor_user,
					'task_types': [task_type.value for task_type in PRODUCTION_TASK_TYPES],
					'priority': 1,
				}
			)
			.execute()
		)
	task_id = queued.data[0]['id']

	try:
		assert background_process() is BackgroundProcessResult.WORKED
	finally:
		with use_client(auth_token) as client:
			remaining = client.table(settings.queue_table).select('id').eq('id', task_id).execute().data
			client.table(settings.queue_table).delete().eq('id', task_id).execute()
	assert remaining == []

	# The archive ortho is transferred once; every later stage reuses the local copy.
	assert pulls == [f'{settings.STORAGE_SERVER_DATA_PATH}/archive/{dataset_id}_ortho.tif']

	with use_client(auth_token) as client:
		status = client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute().data[0]
		labels = (
			client.table(settings.labels_table)
			.select('label_data,model_config')
			.eq('dataset_id', dataset_id)
			.execute()
			.data
		)

	assert not status['has_error'], status['error_message']
	for flag in (
		'is_ortho_done',
		'is_cog_done',
		'is_thumbnail_done',
		'is_metadata_done',
		'is_aoi_done',
		'is_deadwood_done',
		'is_forest_cover_done',
		'is_combined_model_done',
		'is_embeddings_done',
	):
		assert status[flag], flag

	forest_cover_modules = {
		label['model_config']['module']
		for label in labels
		if label['label_data'] == LabelDataEnum.forest_cover.value and label['model_config']
	}
	assert 'treecover_segmentation_oam_tcd' in forest_cover_modules
