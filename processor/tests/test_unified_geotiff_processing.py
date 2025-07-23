import pytest
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, StatusEnum
from processor.src.process_geotiff import process_geotiff
from processor.src.utils.ssh import push_file_to_storage_server


@pytest.fixture
def geotiff_direct_upload_task(test_dataset_for_processing, test_processor_user):
	"""Create a test task for direct GeoTIFF upload processing"""
	return QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.geotiff],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={},
	)


@pytest.fixture
def geotiff_odm_generated_task(auth_token, test_file, test_processor_user):
	"""Create a test task simulating ODM-generated orthomosaic processing"""
	dataset_id = None

	try:
		# Create test dataset in database (simulating ZIP upload)
		with use_client(auth_token) as client:
			dataset_data = {
				'file_name': 'test_odm_images.zip',  # ZIP filename
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

			# Push the same test file as ODM-generated orthomosaic
			ortho_file_name = f'{dataset_id}_ortho.tif'
			archive_path = f'{settings.STORAGE_SERVER_DATA_PATH}/archive/{ortho_file_name}'
			push_file_to_storage_server(str(test_file), archive_path, auth_token, dataset_id)

			# Create status entry indicating ODM is done
			status_data = {
				'dataset_id': dataset_id,
				'current_status': StatusEnum.idle,
				'is_upload_done': True,
				'is_odm_done': True,  # ODM processing completed
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

			# Create task for geotiff processing of ODM-generated file
			task = QueueTask(
				id=2,
				dataset_id=dataset_id,
				user_id=test_processor_user,
				task_types=[TaskTypeEnum.geotiff],
				priority=1,
				is_processing=False,
				current_position=1,
				estimated_time=0.0,
				build_args={},
			)

			yield task

	finally:
		# Cleanup
		if dataset_id:
			with use_client(auth_token) as client:
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()


def test_unified_geotiff_processing_creates_ortho_entry_for_direct_upload(geotiff_direct_upload_task, auth_token):
	"""Test that geotiff processing creates ortho entry for direct GeoTIFF upload"""
	# Process the direct upload
	process_geotiff(geotiff_direct_upload_task, settings.processing_path)

	with use_client(auth_token) as client:
		# Verify ortho entry was created
		ortho_response = (
			client.table(settings.orthos_table)
			.select('*')
			.eq('dataset_id', geotiff_direct_upload_task.dataset_id)
			.execute()
		)
		assert len(ortho_response.data) == 1
		ortho_data = ortho_response.data[0]

		# Verify essential ortho fields
		assert ortho_data['dataset_id'] == geotiff_direct_upload_task.dataset_id
		assert ortho_data['ortho_file_name'].endswith('_ortho.tif')
		assert ortho_data['version'] == 1
		assert ortho_data['sha256'] is not None
		assert ortho_data['ortho_info'] is not None
		assert ortho_data['bbox'] is not None

		# Verify processed ortho entry was also created
		processed_response = (
			client.table(settings.orthos_processed_table)
			.select('*')
			.eq('dataset_id', geotiff_direct_upload_task.dataset_id)
			.execute()
		)
		assert len(processed_response.data) == 1

		# Verify status updated
		status_response = (
			client.table(settings.statuses_table)
			.select('*')
			.eq('dataset_id', geotiff_direct_upload_task.dataset_id)
			.execute()
		)
		assert status_response.data[0]['is_ortho_done'] is True

		# Cleanup
		client.table(settings.orthos_table).delete().eq('dataset_id', geotiff_direct_upload_task.dataset_id).execute()
		client.table(settings.orthos_processed_table).delete().eq(
			'dataset_id', geotiff_direct_upload_task.dataset_id
		).execute()


def test_unified_geotiff_processing_creates_ortho_entry_for_odm_generated(geotiff_odm_generated_task, auth_token):
	"""Test that geotiff processing creates ortho entry for ODM-generated orthomosaic"""
	# Process the ODM-generated file
	process_geotiff(geotiff_odm_generated_task, settings.processing_path)

	with use_client(auth_token) as client:
		# Verify ortho entry was created (same as direct upload)
		ortho_response = (
			client.table(settings.orthos_table)
			.select('*')
			.eq('dataset_id', geotiff_odm_generated_task.dataset_id)
			.execute()
		)
		assert len(ortho_response.data) == 1
		ortho_data = ortho_response.data[0]

		# Verify essential ortho fields (identical structure to direct upload)
		assert ortho_data['dataset_id'] == geotiff_odm_generated_task.dataset_id
		assert ortho_data['ortho_file_name'].endswith('_ortho.tif')
		assert ortho_data['version'] == 1
		assert ortho_data['sha256'] is not None
		assert ortho_data['ortho_info'] is not None
		assert ortho_data['bbox'] is not None

		# Verify processed ortho entry was also created
		processed_response = (
			client.table(settings.orthos_processed_table)
			.select('*')
			.eq('dataset_id', geotiff_odm_generated_task.dataset_id)
			.execute()
		)
		assert len(processed_response.data) == 1

		# Verify status updated (preserving ODM completion status)
		status_response = (
			client.table(settings.statuses_table)
			.select('*')
			.eq('dataset_id', geotiff_odm_generated_task.dataset_id)
			.execute()
		)
		status_data = status_response.data[0]
		assert status_data['is_ortho_done'] is True
		assert status_data['is_odm_done'] is True  # ODM status preserved

		# Cleanup
		client.table(settings.orthos_table).delete().eq('dataset_id', geotiff_odm_generated_task.dataset_id).execute()
		client.table(settings.orthos_processed_table).delete().eq(
			'dataset_id', geotiff_odm_generated_task.dataset_id
		).execute()


def test_identical_database_state_regardless_of_source(
	geotiff_direct_upload_task, geotiff_odm_generated_task, auth_token
):
	"""Test that both upload types result in identical database state after geotiff processing"""

	# Process both tasks
	process_geotiff(geotiff_direct_upload_task, settings.processing_path)
	process_geotiff(geotiff_odm_generated_task, settings.processing_path)

	with use_client(auth_token) as client:
		# Get ortho entries for both
		direct_ortho = (
			client.table(settings.orthos_table)
			.select('*')
			.eq('dataset_id', geotiff_direct_upload_task.dataset_id)
			.execute()
		).data[0]

		odm_ortho = (
			client.table(settings.orthos_table)
			.select('*')
			.eq('dataset_id', geotiff_odm_generated_task.dataset_id)
			.execute()
		).data[0]

		# Get processed ortho entries for both
		direct_processed = (
			client.table(settings.orthos_processed_table)
			.select('*')
			.eq('dataset_id', geotiff_direct_upload_task.dataset_id)
			.execute()
		).data[0]

		odm_processed = (
			client.table(settings.orthos_processed_table)
			.select('*')
			.eq('dataset_id', geotiff_odm_generated_task.dataset_id)
			.execute()
		).data[0]

		# Compare structure and essential fields (dataset_id will differ)
		fields_to_compare = ['version', 'bbox']
		for field in fields_to_compare:
			assert direct_ortho[field] == odm_ortho[field], f'Field {field} differs between sources'

		# Compare ortho_info structure (excluding path which will differ)
		direct_info = direct_ortho['ortho_info'].copy()
		odm_info = odm_ortho['ortho_info'].copy()

		# Remove path fields which are expected to differ
		direct_info.pop('Path', None)
		odm_info.pop('Path', None)

		# Compare remaining ortho_info fields
		assert direct_info == odm_info, f'ortho_info structure differs between sources'

		# Both should have valid SHA256 (values may differ due to different content)
		assert direct_ortho['sha256'] is not None
		assert odm_ortho['sha256'] is not None

		# Both should have ortho file names ending with '_ortho.tif'
		assert direct_ortho['ortho_file_name'].endswith('_ortho.tif')
		assert odm_ortho['ortho_file_name'].endswith('_ortho.tif')

		# Both processed entries should have same compression
		assert direct_processed['ortho_info']['Compression'] == odm_processed['ortho_info']['Compression']

		# Both should have valid processing runtimes
		assert direct_processed['ortho_processing_runtime'] > 0
		assert odm_processed['ortho_processing_runtime'] > 0

		# Cleanup
		client.table(settings.orthos_table).delete().eq('dataset_id', geotiff_direct_upload_task.dataset_id).execute()
		client.table(settings.orthos_processed_table).delete().eq(
			'dataset_id', geotiff_direct_upload_task.dataset_id
		).execute()
		client.table(settings.orthos_table).delete().eq('dataset_id', geotiff_odm_generated_task.dataset_id).execute()
		client.table(settings.orthos_processed_table).delete().eq(
			'dataset_id', geotiff_odm_generated_task.dataset_id
		).execute()
