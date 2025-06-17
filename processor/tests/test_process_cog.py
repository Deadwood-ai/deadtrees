import pytest
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, StatusEnum
from processor.src.process_cog import process_cog
from processor.src.process_geotiff import process_geotiff
from processor.src.processor import process_task
from processor.src.utils.ssh import check_file_exists_on_storage


@pytest.fixture
def cog_task(test_dataset_for_processing, test_processor_user):
	"""Create a test task for COG processing"""
	return QueueTask(
		id=1,
		dataset_id=test_dataset_for_processing,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.cog],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		# build_args={'profile': 'jpeg', 'tiling_scheme': '512', 'quality': 75},
	)


@pytest.fixture
def small_test_file():
	"""Fixture to provide small test GeoTIFF file path for comprehensive testing"""
	# Look for small test files first
	small_files_dir = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'small'
	if small_files_dir.exists():
		small_files = list(small_files_dir.glob('small_*.tif'))
		if small_files:
			return small_files[0]

	# Fallback to existing small test files
	fallback_files = ['test-data-small.tif', 'utm-small.tif', 'corrupted-crs-small.tif']

	assets_dir = Path(__file__).parent.parent.parent / 'assets' / 'test_data'
	for filename in fallback_files:
		file_path = assets_dir / filename
		if file_path.exists():
			return file_path

	pytest.skip('No small test file found. Run scripts/create_small_test_data.py first.')


@pytest.fixture
def comprehensive_test_dataset(auth_token, small_test_file, test_processor_user):
	"""Create a test dataset for comprehensive pipeline testing using small test file"""
	from datetime import datetime
	from shared.models import Ortho
	from processor.src.utils.ssh import push_file_to_storage_server

	dataset_id = None
	file_name = f'comprehensive_test_{small_test_file.name}'

	try:
		# Create test dataset in database
		with use_client(auth_token) as client:
			dataset_data = {
				'file_name': file_name,
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
			ortho_file_name = f'{dataset_id}_ortho.tif'

			ortho_path = Path(settings.BASE_DIR) / settings.ARCHIVE_DIR / ortho_file_name
			push_file_to_storage_server(str(small_test_file), str(ortho_path), auth_token, dataset_id)

			# Add ortho entry
			ortho_data = {
				'dataset_id': dataset_id,
				'ortho_file_name': ortho_file_name,
				'version': 1,
				'ortho_file_size': max(1, int((small_test_file.stat().st_size / 1024 / 1024))),  # in MB
				'bbox': 'BOX(13.4050 52.5200,13.4150 52.5300)',  # Example bbox for Berlin
				'ortho_upload_runtime': 0.1,
				'ortho_info': {'Driver': 'GTiff', 'Size': [512, 512]},  # Small size for test
				'created_at': datetime.now(),
			}
			ortho = Ortho(**ortho_data)
			client.table(settings.orthos_table).insert(ortho.model_dump()).execute()

			# Create initial status entry with is_upload_done set to True
			status_data = {
				'dataset_id': dataset_id,
				'current_status': StatusEnum.idle,
				'is_upload_done': True,  # This is needed for processing to begin
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
				client.table(settings.logs_table).delete().neq('id', 1).execute()


@pytest.fixture
def comprehensive_cog_task(comprehensive_test_dataset, test_processor_user):
	"""Create a test task for COG processing in comprehensive test"""
	return QueueTask(
		id=2,
		dataset_id=comprehensive_test_dataset,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.geotiff, TaskTypeEnum.thumbnail, TaskTypeEnum.cog],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
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

		# Verify COG metadata in db
		assert cog_data['dataset_id'] == cog_task.dataset_id
		assert cog_data['cog_file_name'].endswith('cog.tif')
		assert cog_data['cog_file_size'] > 0
		assert cog_data['cog_info'] is not None

		# assert cog_data['cog_info']['Profile']['Nodata'] == 0

		# Verify COG file exists on storage server
		remote_path = f'{settings.STORAGE_SERVER_DATA_PATH}/{settings.COG_DIR}/{cog_data["cog_file_name"]}'
		assert check_file_exists_on_storage(remote_path, auth_token)


@pytest.fixture
def all_small_test_files():
	"""Fixture to provide all small test GeoTIFF files for comprehensive testing"""
	small_files_dir = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'debugging' / 'testcases' / 'small'

	if not small_files_dir.exists():
		pytest.skip(f'Small test files directory not found: {small_files_dir}')

	small_files = list(small_files_dir.glob('*.tif'))
	if not small_files:
		pytest.skip(f'No test files found in {small_files_dir}')

	return small_files


def create_test_dataset(auth_token, test_file, test_processor_user):
	"""Helper function to create a test dataset for a given file"""
	from datetime import datetime
	from shared.models import Ortho
	from processor.src.utils.ssh import push_file_to_storage_server

	file_name = f'comprehensive_test_{test_file.name}'

	# Create test dataset in database
	with use_client(auth_token) as client:
		dataset_data = {
			'file_name': file_name,
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
		ortho_file_name = f'{dataset_id}_ortho.tif'

		ortho_path = Path(settings.BASE_DIR) / settings.ARCHIVE_DIR / ortho_file_name
		push_file_to_storage_server(str(test_file), str(ortho_path), auth_token, dataset_id)

		# Add ortho entry
		ortho_data = {
			'dataset_id': dataset_id,
			'ortho_file_name': ortho_file_name,
			'version': 1,
			'ortho_file_size': max(1, int((test_file.stat().st_size / 1024 / 1024))),  # in MB
			'bbox': 'BOX(13.4050 52.5200,13.4150 52.5300)',  # Example bbox for Berlin
			'ortho_upload_runtime': 0.1,
			'ortho_info': {'Driver': 'GTiff', 'Size': [512, 512]},  # Small size for test
			'created_at': datetime.now(),
		}
		ortho = Ortho(**ortho_data)
		client.table(settings.orthos_table).insert(ortho.model_dump()).execute()

		# Create initial status entry with is_upload_done set to True
		status_data = {
			'dataset_id': dataset_id,
			'current_status': StatusEnum.idle,
			'is_upload_done': True,  # This is needed for processing to begin
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

		return dataset_id


def cleanup_test_dataset(auth_token, dataset_id):
	"""Helper function to cleanup test dataset"""
	with use_client(auth_token) as client:
		client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()
		client.table(settings.logs_table).delete().neq('id', 1).execute()


@pytest.mark.slow
@pytest.mark.comprehensive
def test_comprehensive_all_small_files_pipeline(all_small_test_files, auth_token, test_processor_user):
	"""
	Comprehensive test for all small test files: geotiff -> cog -> thumbnail -> metadata

	This test processes all files in assets/test_data/debugging/testcases/small/
	and runs the full pipeline for each file.

	To run this test:
		pytest -m "slow and comprehensive" processor/tests/test_process_cog.py::test_comprehensive_all_small_files_pipeline
	"""
	print(f'\n=== Testing {len(all_small_test_files)} small test files ===')

	successful_files = []
	failed_files = []
	all_datasets = []

	for test_file in all_small_test_files:
		print(f'\n--- Processing {test_file.name} ---')
		dataset_id = None

		try:
			# Create dataset for this file
			dataset_id = create_test_dataset(auth_token, test_file, test_processor_user)
			all_datasets.append(dataset_id)
			# Create comprehensive task with all processing steps (like test_processor.py)
			task = QueueTask(
				id=1,
				dataset_id=dataset_id,
				user_id=test_processor_user,
				task_types=[
					TaskTypeEnum.geotiff,
					TaskTypeEnum.cog,
					TaskTypeEnum.thumbnail,
					TaskTypeEnum.metadata,
				],
				priority=1,
				is_processing=False,
				current_position=1,
				estimated_time=0.0,
			)

			# Process all tasks using the processor function (same as test_processor.py)
			process_task(task, auth_token)

			# Verify all processing completed successfully (same checks as test_processor.py)
			with use_client(auth_token) as client:
				# Check GeoTIFF processing
				ortho_response = (
					client.table(settings.orthos_processed_table).select('*').eq('dataset_id', dataset_id).execute()
				)
				assert len(ortho_response.data) == 1, f'GeoTIFF processing failed for {test_file.name}'
				assert ortho_response.data[0]['ortho_processing_runtime'] > 0

				# Check COG processing
				cog_response = client.table(settings.cogs_table).select('*').eq('dataset_id', dataset_id).execute()
				assert len(cog_response.data) == 1, f'COG processing failed for {test_file.name}'
				assert cog_response.data[0]['cog_file_size'] > 0
				assert cog_response.data[0]['cog_info'] is not None

				# Check thumbnail processing
				thumbnail_response = (
					client.table(settings.thumbnails_table).select('*').eq('dataset_id', dataset_id).execute()
				)
				assert len(thumbnail_response.data) == 1, f'Thumbnail processing failed for {test_file.name}'
				assert thumbnail_response.data[0]['thumbnail_file_size'] > 0
				assert thumbnail_response.data[0]['thumbnail_processing_runtime'] > 0

				# Check metadata processing
				metadata_response = (
					client.table(settings.metadata_table).select('*').eq('dataset_id', dataset_id).execute()
				)
				assert len(metadata_response.data) == 1, f'Metadata processing failed for {test_file.name}'
				assert metadata_response.data[0]['processing_runtime'] > 0
				assert 'gadm' in metadata_response.data[0]['metadata']
				assert 'biome' in metadata_response.data[0]['metadata']

				# Verify final status (same as test_processor.py)
				status_response = (
					client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute()
				)
				assert len(status_response.data) == 1
				status = status_response.data[0]
				assert status['current_status'] == StatusEnum.idle
				assert status['is_ortho_done'] is True
				assert status['is_cog_done'] is True
				assert status['is_thumbnail_done'] is True
				assert status['is_metadata_done'] is True
				assert not status['has_error'], f'Processing had errors for {test_file.name}'

			successful_files.append(test_file.name)

			print(f'✅ Successfully processed {test_file.name}')

		except Exception as e:
			failed_files.append((test_file.name, str(e)))
			print(f'❌ Failed to process {test_file.name}: {str(e)}')

	# Final summary
	print(f'\n=== FINAL RESULTS ===')
	print(f'✅ Successful: {len(successful_files)}/{len(all_small_test_files)} files')
	print(f'❌ Failed: {len(failed_files)}/{len(all_small_test_files)} files')

	if successful_files:
		print(f'\nSuccessful files:')
		for filename in successful_files:
			print(f'  - {filename}')

	if failed_files:
		print(f'\nFailed files:')
		for filename, error in failed_files:
			print(f'  - {filename}: {error}')

	# Test passes if at least 50% of files processed successfully
	success_rate = len(successful_files) / len(all_small_test_files)
	assert success_rate >= 0.5, f'Success rate too low: {success_rate:.1%} (expected >= 50%)'

	print(f'\n✅ Comprehensive test passed with {success_rate:.1%} success rate')

	# Clean up all datasets at the end
	for dataset_id in all_datasets:
		cleanup_test_dataset(auth_token, dataset_id)
