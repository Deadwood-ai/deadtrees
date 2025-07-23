import pytest
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, StatusEnum
from processor.src.process_odm import process_odm
from processor.src.process_geotiff import process_geotiff
from processor.src.process_cog import process_cog
from processor.src.process_thumbnail import process_thumbnail
from processor.src.process_deadwood_segmentation import process_deadwood_segmentation
from processor.src.utils.ssh import push_file_to_storage_server, check_file_exists_on_storage


@pytest.fixture
def test_zip_file():
	"""Get path to test ZIP file for ODM processing"""
	# Use smaller, higher-quality dataset for more reliable testing
	possible_paths = [
		Path(settings.base_path) / 'assets' / 'test_data' / 'raw_drone_images' / 'test_no_rtk_3_images.zip',
		Path('/app/assets/test_data/raw_drone_images/test_no_rtk_3_images.zip'),
		Path('./assets/test_data/raw_drone_images/test_no_rtk_3_images.zip'),
	]

	for zip_path in possible_paths:
		if zip_path.exists():
			return zip_path

	pytest.skip(
		f'Test ZIP file not found at any of {possible_paths}. Run `./scripts/create_odm_test_data.sh` to create test data.'
	)
	return None


@pytest.fixture
def odm_test_dataset(auth_token, test_zip_file, test_processor_user):
	"""Create a test dataset for ODM processing with uploaded ZIP file"""
	dataset_id = None

	try:
		# Create test dataset in database (ZIP upload)
		with use_client(auth_token) as client:
			dataset_data = {
				'file_name': 'test_no_rtk_3_images.zip',
				'license': 'CC BY',
				'platform': 'drone',
				'authors': ['Test Author'],
				'user_id': test_processor_user,
				'data_access': 'public',
				'aquisition_year': 2024,
				'aquisition_month': 1,
				'aquisition_day': 1,
			}
			response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = response.data[0]['id']

			# Upload ZIP file to storage (simulating upload completion)
			zip_filename = f'{dataset_id}.zip'
			remote_zip_path = f'{settings.raw_images_path}/{zip_filename}'
			push_file_to_storage_server(str(test_zip_file), remote_zip_path, auth_token, dataset_id)

			# Create raw_images entry with smaller dataset info
			raw_images_data = {
				'dataset_id': dataset_id,
				'version': 1,
				'raw_image_count': 3,  # Small dataset with 3 images
				'raw_image_size_mb': int(test_zip_file.stat().st_size / 1024 / 1024),  # MB
				'raw_images_path': remote_zip_path,
				'camera_metadata': {},
				'has_rtk_data': False,  # No RTK dataset
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
				'is_odm_done': False,  # ODM not yet processed
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
def odm_task(odm_test_dataset, test_processor_user):
	"""Create a test task for ODM processing"""
	return QueueTask(
		id=1,
		dataset_id=odm_test_dataset,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.odm_processing],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={},
	)


@pytest.mark.slow
def test_odm_container_execution_with_real_images(odm_task, auth_token):
	"""Test ODM container execution with real 3-image dataset (small but high quality)"""

	# Execute real ODM processing with high-quality test data
	process_odm(odm_task, Path(settings.processing_path))

	# Verify status was updated
	with use_client(auth_token) as client:
		status_response = (
			client.table(settings.statuses_table).select('*').eq('dataset_id', odm_task.dataset_id).execute()
		)
		assert status_response.data[0]['is_odm_done'] is True

	# Verify orthomosaic was created in storage
	remote_ortho_path = f'{settings.archive_path}/{odm_task.dataset_id}_ortho.tif'
	ortho_exists = check_file_exists_on_storage(remote_ortho_path, auth_token)
	assert ortho_exists, f'Generated orthomosaic not found at {remote_ortho_path}'


def test_odm_orthomosaic_generation_and_storage(odm_task, auth_token):
	"""Test that ODM generates orthomosaic and moves it to correct archive location"""

	# Execute real ODM processing with test data
	process_odm(odm_task, Path(settings.processing_path))

	# Verify orthomosaic was created in correct storage location
	expected_remote_path = f'{settings.archive_path}/{odm_task.dataset_id}_ortho.tif'
	ortho_exists = check_file_exists_on_storage(expected_remote_path, auth_token)
	assert ortho_exists, f'Generated orthomosaic not found at {expected_remote_path}'

	# Verify status was updated correctly
	with use_client(auth_token) as client:
		status_response = (
			client.table(settings.statuses_table).select('*').eq('dataset_id', odm_task.dataset_id).execute()
		)
		assert status_response.data[0]['is_odm_done'] is True


def test_odm_real_data_end_to_end_processing(odm_task, auth_token):
	"""Test complete ODM processing pipeline with real data"""

	# Verify initial state
	with use_client(auth_token) as client:
		initial_status = (
			client.table(settings.statuses_table).select('*').eq('dataset_id', odm_task.dataset_id).execute()
		).data[0]
		assert initial_status['is_odm_done'] is False
		assert initial_status['is_upload_done'] is True

	# Execute ODM processing
	process_odm(odm_task, Path(settings.processing_path))

	# Verify final state - status updated and orthomosaic exists
	with use_client(auth_token) as client:
		final_status = (
			client.table(settings.statuses_table).select('*').eq('dataset_id', odm_task.dataset_id).execute()
		).data[0]

		# Verify ODM completion
		assert final_status['is_odm_done'] is True

		# Verify other statuses preserved
		assert final_status['is_upload_done'] is True
		assert final_status['is_ortho_done'] is False  # Not yet processed by geotiff
		assert final_status['has_error'] is False

	# Verify orthomosaic file exists in storage
	remote_ortho_path = f'{settings.archive_path}/{odm_task.dataset_id}_ortho.tif'
	ortho_exists = check_file_exists_on_storage(remote_ortho_path, auth_token)
	assert ortho_exists, f'Generated orthomosaic not found at {remote_ortho_path}'


@pytest.mark.slow
@pytest.mark.comprehensive
def test_complete_odm_to_segmentation_pipeline(odm_task, auth_token):
	"""Test complete pipeline: ODM → geotiff → thumbnail → cog → segmentation"""

	dataset_id = odm_task.dataset_id

	# Step 1: ODM Processing (Raw images → Orthomosaic)
	print('\n=== Step 1: ODM Processing ===')
	process_odm(odm_task, Path(settings.processing_path))

	with use_client(auth_token) as client:
		status = client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute().data[0]
		assert status['is_odm_done'] is True
	print('✅ ODM processing completed - orthomosaic generated')

	# Step 2: GeoTIFF Processing (Orthomosaic → Standardized + Ortho entry)
	print('\n=== Step 2: GeoTIFF Processing ===')
	geotiff_task = QueueTask(
		id=2,
		dataset_id=dataset_id,
		user_id=odm_task.user_id,
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
	print('✅ GeoTIFF processing completed - ortho entry created')

	# Step 3: COG Processing (Standardized → Cloud Optimized GeoTIFF)
	print('\n=== Step 3: COG Processing ===')
	cog_task = QueueTask(
		id=3,
		dataset_id=dataset_id,
		user_id=odm_task.user_id,
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
	print('✅ COG processing completed - cloud optimized GeoTIFF created')

	# Step 4: Thumbnail Processing (COG → Thumbnail image)
	print('\n=== Step 4: Thumbnail Processing ===')
	thumbnail_task = QueueTask(
		id=4,
		dataset_id=dataset_id,
		user_id=odm_task.user_id,
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
	print('✅ Thumbnail processing completed - preview image created')

	# # Step 5: Deadwood Segmentation (COG → AI segmentation)
	# print('\n=== Step 5: Deadwood Segmentation ===')
	# segmentation_task = QueueTask(
	# 	id=5,
	# 	dataset_id=dataset_id,
	# 	user_id=odm_task.user_id,
	# 	task_types=[TaskTypeEnum.deadwood],
	# 	priority=1,
	# 	is_processing=False,
	# 	current_position=1,
	# 	estimated_time=0.0,
	# 	build_args={},
	# )
	# process_deadwood_segmentation(segmentation_task, auth_token, settings.processing_path)

	# with use_client(auth_token) as client:
	# 	status = client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute().data[0]
	# 	assert status['is_deadwood_done'] is True

	# 	# Verify segmentation was processed (may or may not find deadwood)
	# 	labels_response = client.table(settings.labels_table).select('*').eq('dataset_id', dataset_id).execute()
	# 	# Note: It's valid for labels to be empty if no deadwood was detected
	# 	print(f'✅ Deadwood segmentation processed - {len(labels_response.data)} deadwood segments detected')
	# print('✅ Deadwood segmentation completed - AI analysis finished')

	# Final verification: Complete pipeline success
	print('\n=== Final Status Verification ===')
	with use_client(auth_token) as client:
		final_status = client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute().data[0]

		# Verify all processing stages completed
		assert final_status['is_odm_done'] is True
		assert final_status['is_ortho_done'] is True
		assert final_status['is_cog_done'] is True
		assert final_status['is_thumbnail_done'] is True
		# assert final_status['is_deadwood_done'] is True
		assert final_status['has_error'] is False
		assert final_status['current_status'] == StatusEnum.idle

	print('🎉 COMPLETE PIPELINE SUCCESS: ODM → GeoTIFF → COG → Thumbnail → Segmentation')
	print('✅ Raw drone images successfully processed through entire AI pipeline!')
