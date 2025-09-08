"""
Integration tests for complete processing pipeline.

Tests end-to-end workflows spanning multiple processing stages:
ODM → GeoTIFF → COG → Thumbnail → Segmentation
"""

import pytest
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, StatusEnum
from processor.src.process_odm import process_odm
from processor.src.process_geotiff import process_geotiff
from processor.src.process_cog import process_cog
from processor.src.process_thumbnail import process_thumbnail
from processor.src.utils.ssh import push_file_to_storage_server


@pytest.fixture
def pipeline_test_zip():
	"""Get path to test ZIP file for complete pipeline testing"""
	possible_paths = [
		Path(settings.base_path) / 'assets' / 'test_data' / 'raw_drone_images' / 'test_minimal_5_images.zip',
		Path('/app/assets/test_data/raw_drone_images/test_minimal_5_images.zip'),
		Path('./assets/test_data/raw_drone_images/test_minimal_5_images.zip'),
	]

	for zip_path in possible_paths:
		if zip_path.exists():
			return zip_path

	pytest.skip(
		f'Pipeline test ZIP file not found at any of {possible_paths}. Run `./scripts/create_odm_test_data.sh` to create test data.'
	)


@pytest.fixture
def pipeline_test_dataset(auth_token, pipeline_test_zip, test_processor_user):
	"""Create a test dataset for complete pipeline testing"""
	dataset_id = None

	try:
		# Create test dataset in database
		with use_client(auth_token) as client:
			dataset_data = {
				'file_name': 'test_minimal_5_images.zip',
				'license': 'CC BY',
				'platform': 'drone',
				'authors': ['Pipeline Test Author'],
				'user_id': test_processor_user,
				'data_access': 'public',
				'aquisition_year': 2024,
				'aquisition_month': 1,
				'aquisition_day': 1,
			}
			response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = response.data[0]['id']

			# Upload ZIP file to storage
			zip_filename = f'{dataset_id}.zip'
			remote_zip_path = f'{settings.raw_images_path}/{zip_filename}'
			push_file_to_storage_server(str(pipeline_test_zip), remote_zip_path, auth_token, dataset_id)

			# Create raw_images entry
			raw_images_data = {
				'dataset_id': dataset_id,
				'version': 1,
				'raw_image_count': 0,
				'raw_image_size_mb': int(pipeline_test_zip.stat().st_size / 1024 / 1024),
				'raw_images_path': remote_zip_path,
				'camera_metadata': {},
				'has_rtk_data': False,
				'rtk_precision_cm': None,
				'rtk_quality_indicator': None,
				'rtk_file_count': 0,
			}
			client.table(settings.raw_images_table).insert(raw_images_data).execute()

			# Create status entry
			status_data = {
				'dataset_id': dataset_id,
				'current_status': StatusEnum.idle,
				'is_upload_done': True,
				'is_odm_done': False,
				'is_ortho_done': False,
				'is_cog_done': False,
				'is_thumbnail_done': False,
				'is_deadwood_done': False,
				'is_forest_cover_done': False,
				'is_metadata_done': False,
				'is_audited': False,
				'has_error': False,
			}
			client.table(settings.statuses_table).insert(status_data).execute()

			yield dataset_id

	finally:
		# Cleanup
		if dataset_id:
			with use_client(auth_token) as client:
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.raw_images_table).delete().eq('dataset_id', dataset_id).execute()


@pytest.fixture
def pipeline_odm_task(pipeline_test_dataset, test_processor_user):
	"""Create ODM task for pipeline testing"""
	return QueueTask(
		id=1,
		dataset_id=pipeline_test_dataset,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.odm_processing],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={},
	)


@pytest.mark.slow
@pytest.mark.comprehensive
def test_complete_odm_to_thumbnail_pipeline(pipeline_odm_task, auth_token):
	"""Test complete pipeline: ODM → GeoTIFF → COG → Thumbnail"""

	dataset_id = pipeline_odm_task.dataset_id

	# Step 1: ODM Processing (Raw images → Orthomosaic)
	process_odm(pipeline_odm_task, Path(settings.processing_path))

	with use_client(auth_token) as client:
		status = client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute().data[0]
		assert status['is_odm_done'] is True

	# Step 2: GeoTIFF Processing (Orthomosaic → Standardized + Ortho entry)

	geotiff_task = QueueTask(
		id=2,
		dataset_id=dataset_id,
		user_id=pipeline_odm_task.user_id,
		task_types=[TaskTypeEnum.geotiff],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={},
	)
	process_geotiff(geotiff_task, settings.processing_path)

	with use_client(auth_token) as client:
		status = client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute().data[0]
		assert status['is_ortho_done'] is True

		# Verify ortho entry was created
		ortho_response = client.table(settings.orthos_table).select('*').eq('dataset_id', dataset_id).execute()
		assert len(ortho_response.data) == 1

	# Step 3: COG Processing (Standardized → Cloud Optimized GeoTIFF)
	cog_task = QueueTask(
		id=3,
		dataset_id=dataset_id,
		user_id=pipeline_odm_task.user_id,
		task_types=[TaskTypeEnum.cog],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={},
	)
	process_cog(cog_task, settings.processing_path)

	with use_client(auth_token) as client:
		status = client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute().data[0]
		assert status['is_cog_done'] is True

		# Verify COG entry was created
		cog_response = client.table(settings.cogs_table).select('*').eq('dataset_id', dataset_id).execute()
		assert len(cog_response.data) == 1

	# Step 4: Thumbnail Processing (COG → Thumbnail image)

	thumbnail_task = QueueTask(
		id=4,
		dataset_id=dataset_id,
		user_id=pipeline_odm_task.user_id,
		task_types=[TaskTypeEnum.thumbnail],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={},
	)
	process_thumbnail(thumbnail_task, settings.processing_path)

	with use_client(auth_token) as client:
		status = client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute().data[0]
		assert status['is_thumbnail_done'] is True

		# Verify thumbnail entry was created
		thumbnail_response = client.table(settings.thumbnails_table).select('*').eq('dataset_id', dataset_id).execute()
		assert len(thumbnail_response.data) == 1

	# Final verification: Complete pipeline success
	with use_client(auth_token) as client:
		final_status = client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute().data[0]

		# Verify all processing stages completed
		assert final_status['is_odm_done'] is True
		assert final_status['is_ortho_done'] is True
		assert final_status['is_cog_done'] is True
		assert final_status['is_thumbnail_done'] is True
		assert final_status['has_error'] is False
		assert final_status['current_status'] == StatusEnum.idle
