import pytest
from pathlib import Path

from shared.supabase import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask
from processor.src.process_cog import process_cog


@pytest.fixture
def cog_task(test_dataset_for_processing, test_processor_user):
	"""Create a test task for COG processing"""
	return QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_type=TaskTypeEnum.cog,
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={'profile': 'webp', 'tiling_scheme': '512', 'quality': 75},
	)


def test_process_cog_success(cog_task, auth_token):
	"""Test successful COG processing"""
	# Process the COG
	process_cog(cog_task, settings.processing_path)

	# Verify COG was created in database
	with use_client(auth_token) as client:
		response = client.table(settings.cogs_table).select('*').eq('dataset_id', cog_task.dataset_id).execute()
		assert len(response.data) == 1
		cog_data = response.data[0]

		# Verify essential COG fields
		assert cog_data['dataset_id'] == cog_task.dataset_id
		assert cog_data['file_name'].endswith('.tif')
		assert cog_data['file_size'] > 0
		assert cog_data['profile'] == cog_task.build_args['profile']
		assert cog_data['tiling_scheme'] == cog_task.build_args['tiling_scheme']
		assert cog_data['quality'] == cog_task.build_args['quality']

		# Verify COG file exists in correct location
		cog_path = Path(settings.BASE_DIR) / settings.COG_DIR / cog_data['file_name']
		assert cog_path.exists()
		assert cog_path.stat().st_size > 0
