import pytest

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask
from processor.src.process_geotiff import process_geotiff
from processor.src.utils.ssh import push_file_to_storage_server

pytestmark = pytest.mark.integration


@pytest.fixture
def convert_task(test_dataset_for_processing, test_processor_user):
	"""Create a test task for GeoTIFF conversion"""
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


def test_process_geotiff_success(convert_task, auth_token):
	"""Test successful GeoTIFF conversion with fresh metadata calculation and both database entries creation"""
	process_geotiff(convert_task, settings.processing_path)

	with use_client(auth_token) as client:
		# Verify original ortho entry exists with fresh metadata (always recalculated)
		ortho_response = (
			client.table(settings.orthos_table).select('*').eq('dataset_id', convert_task.dataset_id).execute()
		)
		assert len(ortho_response.data) == 1
		ortho_data = ortho_response.data[0]

		# Verify essential original ortho fields with fresh metadata
		assert ortho_data['dataset_id'] == convert_task.dataset_id
		assert ortho_data['ortho_file_name'].endswith('ortho.tif')
		assert ortho_data['version'] == 1
		# sha256 and ortho_info should always be freshly calculated
		assert ortho_data['sha256'] is not None
		assert ortho_data['ortho_info'] is not None
		assert ortho_data['bbox'] is not None

		# Verify processed GeoTIFF info was created (existing functionality)
		processed_response = (
			client.table(settings.orthos_processed_table)
			.select('*')
			.eq('dataset_id', convert_task.dataset_id)
			.execute()
		)
		assert len(processed_response.data) == 1
		processed_data = processed_response.data[0]

		# Verify essential processed GeoTIFF info fields
		assert processed_data['dataset_id'] == convert_task.dataset_id
		assert processed_data['ortho_file_name'].endswith('ortho.tif')
		assert processed_data['ortho_processing_runtime'] > 0
		# Compression should be preserved or DEFLATE (JPEG may be converted to DEFLATE if alpha needed)
		compression = processed_data['ortho_info']['Compression']
		assert compression in ['DEFLATE', 'JPEG', 'WEBP', 'LZW'], f'Unexpected compression: {compression}'

		# Clean up by removing both test entries
		client.table(settings.orthos_processed_table).delete().eq('dataset_id', convert_task.dataset_id).execute()
		client.table(settings.orthos_table).delete().eq('dataset_id', convert_task.dataset_id).execute()


@pytest.fixture
def geotiff_task_without_ortho_entry(auth_token, test_file, test_processor_user):
	"""
	Create a dataset + status + archive orthomosaic, but NO v2_orthos entry.

	This exercises the `process_geotiff()` branch that creates the ortho row from
	`/archive/{dataset_id}_ortho.tif` (e.g. ODM-generated orthomosaic scenarios).
	"""
	dataset_id = None
	try:
		with use_client(auth_token) as client:
			dataset_data = {
				'file_name': 'test_odm_images.zip',  # Simulate ZIP upload source
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

			# Push orthomosaic to storage server archive path
			ortho_file_name = f'{dataset_id}_ortho.tif'
			archive_path = f'{settings.STORAGE_SERVER_DATA_PATH}/archive/{ortho_file_name}'
			push_file_to_storage_server(str(test_file), archive_path, auth_token, dataset_id)

			# Create status row indicating upstream ODM was done; geotiff should not clear it.
			status_data = {
				'dataset_id': dataset_id,
				'current_status': 'idle',
				'is_upload_done': True,
				'is_odm_done': True,
				'is_ortho_done': False,
				'has_error': False,
			}
			client.table(settings.statuses_table).insert(status_data).execute()

		yield QueueTask(
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
	finally:
		if dataset_id:
			with use_client(auth_token) as client:
				# Best-effort cleanup (order matters if FK constraints are strict).
				client.table(settings.orthos_processed_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.orthos_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_process_geotiff_creates_ortho_entry_when_missing(geotiff_task_without_ortho_entry, auth_token):
	"""
	If v2_orthos has no row yet, process_geotiff() should create it from the archive file,
	create the processed-ortho row, and preserve upstream flags like is_odm_done.
	"""
	process_geotiff(geotiff_task_without_ortho_entry, settings.processing_path)

	with use_client(auth_token) as client:
		# Ortho row created
		ortho_response = (
			client.table(settings.orthos_table).select('*').eq('dataset_id', geotiff_task_without_ortho_entry.dataset_id).execute()
		)
		assert len(ortho_response.data) == 1

		# Processed-ortho row created
		processed_response = (
			client.table(settings.orthos_processed_table)
			.select('*')
			.eq('dataset_id', geotiff_task_without_ortho_entry.dataset_id)
			.execute()
		)
		assert len(processed_response.data) == 1

		# Status updated, but ODM flag preserved
		status_response = (
			client.table(settings.statuses_table)
			.select('is_ortho_done,is_odm_done,has_error')
			.eq('dataset_id', geotiff_task_without_ortho_entry.dataset_id)
			.execute()
		)
		assert len(status_response.data) == 1
		status = status_response.data[0]
		assert status['is_ortho_done'] is True
		assert status['is_odm_done'] is True
		assert status['has_error'] is False
