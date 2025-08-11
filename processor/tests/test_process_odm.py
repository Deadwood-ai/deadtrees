"""
Consolidated ODM processing tests covering complete functionality.

Tests ODM container execution, EXIF extraction, RTK detection, and orthomosaic generation
in a single comprehensive test suite, eliminating redundancy across multiple test files.
"""

import os
import pytest
from pathlib import Path

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, StatusEnum
from processor.src.process_odm import process_odm
from processor.src.utils.ssh import push_file_to_storage_server, check_file_exists_on_storage


@pytest.fixture
def test_zip_file():
	"""Get path to test ZIP file for ODM processing.

	Resolution order:
	1) DEBUG_ODM_ZIP env var pointing to a local ZIP
	2) Any ZIP under assets/test_data/debugging/<id>/<id>.zip or assets/test_data/debugging/*.zip
	3) Default minimal dataset (5 images + RTK)
	"""
	# 1) Environment override
	env_path = os.getenv('DEBUG_ODM_ZIP')
	if env_path and Path(env_path).exists():
		return Path(env_path)

	# 2) Debugging folder
	debug_dir = Path(settings.base_path) / 'assets' / 'test_data' / 'debugging'
	debug_candidates = []
	if debug_dir.exists():
		debug_candidates.extend(debug_dir.glob('*/[0-9]*.zip'))
		debug_candidates.extend(debug_dir.glob('*.zip'))
	for cand in debug_candidates:
		if cand.exists():
			return cand

	# 3) Default minimal dataset
	possible_paths = [
		Path(settings.base_path) / 'assets' / 'test_data' / 'raw_drone_images' / 'test_minimal_5_images.zip',
		Path('/app/assets/test_data/raw_drone_images/test_minimal_5_images.zip'),
		Path('./assets/test_data/raw_drone_images/test_minimal_5_images.zip'),
	]
	for zip_path in possible_paths:
		if zip_path.exists():
			return zip_path

	pytest.skip(
		'No ODM test ZIP found. Set DEBUG_ODM_ZIP or place a ZIP under assets/test_data/debugging/, '
		'or run `./scripts/create_odm_test_data.sh`.'
	)


@pytest.fixture
def zip_source_type(test_zip_file):
	"""Return 'debug' if the ZIP is from assets/test_data/debugging or via env override, else 'default'."""
	debug_dir = Path(settings.base_path) / 'assets' / 'test_data' / 'debugging'
	if str(test_zip_file).startswith(str(debug_dir)) or os.getenv('DEBUG_ODM_ZIP'):
		return 'debug'
	return 'default'


@pytest.fixture
def odm_test_dataset(auth_token, test_zip_file, test_processor_user):
	"""Create a test dataset for ODM processing with uploaded ZIP file"""
	dataset_id = None

	try:
		# Create test dataset in database (ZIP upload)
		with use_client(auth_token) as client:
			dataset_data = {
				'file_name': 'test_minimal_5_images.zip',
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

			# Create raw_images entry matching new upload flow (minimal info, updated during ODM processing)
			raw_images_data = {
				'dataset_id': dataset_id,
				'version': 1,
				'raw_image_count': 0,  # Placeholder - will be updated during ODM processing
				'raw_image_size_mb': int(test_zip_file.stat().st_size / 1024 / 1024),  # ZIP file size as placeholder
				'raw_images_path': remote_zip_path,
				'camera_metadata': {},  # Will be populated during ODM processing
				'has_rtk_data': False,  # Will be updated during ODM processing
				'rtk_precision_cm': None,  # Will be updated during ODM processing
				'rtk_quality_indicator': None,  # Will be updated during ODM processing
				'rtk_file_count': 0,  # Will be updated during ODM processing
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
def test_complete_odm_processing_with_real_images(odm_task, auth_token, zip_source_type):
	"""
	Test complete ODM processing pipeline with real drone images.

	Covers:
	- ODM container execution with real 5-image dataset
	- EXIF metadata extraction and storage
	- RTK file detection and metadata updates
	- Orthomosaic generation and storage
	- Database status updates
	"""
	dataset_id = odm_task.dataset_id

	# Verify initial state (basic checks only)
	with use_client(auth_token) as client:
		initial_status = (
			client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute()
		).data[0]
		assert initial_status['is_upload_done'] is True

	# Execute ODM processing and capture outcome
	ran_ok = True
	try:
		process_odm(odm_task, Path(settings.processing_path))
	except Exception:
		ran_ok = False

	with use_client(auth_token) as client:
		final_status = (client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute()).data[
			0
		]

	if zip_source_type == 'debug':
		# For real-world debug datasets we allow/expect failure but require error to be recorded
		assert ran_ok is False
		assert final_status['has_error'] is True
		assert isinstance(final_status.get('error_message'), str) and len(final_status.get('error_message')) > 0
	else:
		# Default minimal dataset must succeed and produce expected updates
		assert ran_ok is True
		assert final_status['is_odm_done'] is True
		assert final_status['is_upload_done'] is True
		assert final_status['is_ortho_done'] is False  # Not yet processed by geotiff
		assert final_status['has_error'] is False

		# Verify orthomosaic was generated and stored
		remote_ortho_path = f'{settings.archive_path}/{dataset_id}_ortho.tif'
		ortho_exists = check_file_exists_on_storage(remote_ortho_path, auth_token)
		assert ortho_exists, f'Generated orthomosaic not found at {remote_ortho_path}'

		# Verify metadata updates
		with use_client(auth_token) as client:
			final_raw_images = (
				client.table(settings.raw_images_table).select('*').eq('dataset_id', dataset_id).execute()
			).data[0]

			camera_metadata = final_raw_images['camera_metadata']
			assert camera_metadata is not None and isinstance(camera_metadata, dict) and len(camera_metadata) > 0

			expected_field_categories = [
				['Make', 'Model', 'Software'],
				['ISOSpeedRatings', 'FNumber', 'FocalLength', 'ExposureTime'],
				['DateTime', 'DateTimeOriginal', 'DateTimeDigitized'],
			]
			fields_found = sum(
				1 for category in expected_field_categories if any(field in camera_metadata for field in category)
			)
			assert fields_found >= 2

			raw_image_count = final_raw_images['raw_image_count']
			raw_image_size_mb = final_raw_images['raw_image_size_mb']
			has_rtk_data = final_raw_images['has_rtk_data']
			rtk_file_count = final_raw_images['rtk_file_count']

			assert raw_image_count > 0 and raw_image_size_mb > 0
			assert isinstance(has_rtk_data, bool)
			assert isinstance(rtk_file_count, int)
			assert has_rtk_data is True and rtk_file_count > 0 and raw_image_count == 5
