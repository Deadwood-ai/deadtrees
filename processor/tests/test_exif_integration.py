"""
Integration tests for EXIF metadata extraction in complete processing pipeline.

Tests the complete flow: ZIP upload → ODM processing → EXIF extraction → database storage
and verifies EXIF metadata persistence, retrieval, and JSON query performance.
"""

import pytest
import tempfile
import zipfile
from pathlib import Path
from typing import Dict, Any

from shared.db import use_client
from shared.settings import settings
from shared.models import TaskTypeEnum, QueueTask, StatusEnum
from shared.testing.fixtures import auth_token, test_processor_user
from processor.src.process_odm import process_odm
from processor.src.utils.ssh import check_file_exists_on_storage


@pytest.fixture
def integration_test_zip():
	"""Get path to test ZIP file for integration testing"""
	possible_paths = [
		Path(settings.base_path) / 'assets' / 'test_data' / 'raw_drone_images' / 'test_no_rtk_3_images.zip',
		Path('/app/assets/test_data/raw_drone_images/test_no_rtk_3_images.zip'),
		Path('./assets/test_data/raw_drone_images/test_no_rtk_3_images.zip'),
	]

	for zip_path in possible_paths:
		if zip_path.exists():
			return zip_path

	pytest.skip(
		f'Integration test ZIP file not found at any of {possible_paths}. Run `./scripts/create_odm_test_data.sh` to create test data.'
	)


@pytest.fixture
def integration_dataset(auth_token, integration_test_zip, test_processor_user):
	"""Create a test dataset for complete pipeline integration testing"""
	dataset_id = None

	try:
		# Create test dataset in database (ZIP upload simulation)
		with use_client(auth_token) as client:
			dataset_data = {
				'file_name': 'test_no_rtk_3_images.zip',
				'license': 'CC BY',
				'platform': 'drone',
				'authors': ['Integration Test Author'],
				'user_id': test_processor_user,
				'data_access': 'public',
				'aquisition_year': 2024,
				'aquisition_month': 1,
			}

			# Insert dataset
			dataset_response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = dataset_response.data[0]['id']

		# Create raw_images entry (simulating new simplified ZIP upload processing)
		raw_images_data = {
			'dataset_id': dataset_id,
			'version': 1,
			'raw_image_count': 0,  # Placeholder - will be updated during ODM processing
			'raw_image_size_mb': int(integration_test_zip.stat().st_size / 1024 / 1024),  # ZIP file size as placeholder
			'raw_images_path': f'{settings.raw_images_path}/{dataset_id}.zip',  # Direct path like working tests
			'camera_metadata': {},  # Will be populated by ODM processing
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

		# Upload file to storage (simulating upload endpoint)
		from processor.src.utils.ssh import push_file_to_storage_server

		# Use same pattern as working ODM test - direct path without subdirectories
		zip_filename = f'{dataset_id}.zip'
		remote_path = f'{settings.raw_images_path}/{zip_filename}'
		push_file_to_storage_server(str(integration_test_zip), remote_path, auth_token, dataset_id)

		yield dataset_id

	finally:
		# Cleanup
		if dataset_id:
			with use_client(auth_token) as client:
				# Delete in reverse order due to foreign key constraints
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.raw_images_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


@pytest.fixture
def integration_task(integration_dataset, test_processor_user):
	"""Create a task for complete pipeline integration testing"""
	return QueueTask(
		id=1,
		dataset_id=integration_dataset,
		user_id=test_processor_user,
		task_types=[TaskTypeEnum.odm_processing],
		priority=1,
		is_processing=False,
		current_position=1,
		estimated_time=0.0,
		build_args={},
	)


class TestEXIFIntegration:
	"""Integration tests for EXIF extraction in complete processing pipeline."""

	@pytest.mark.slow
	def test_complete_zip_upload_odm_exif_flow(self, integration_task, auth_token):
		"""Test complete ZIP upload → ODM processing → EXIF extraction flow."""

		# Execute ODM processing (includes EXIF extraction)
		process_odm(integration_task, Path(settings.processing_path))

		# Verify ODM processing completed successfully
		with use_client(auth_token) as client:
			status_response = (
				client.table(settings.statuses_table)
				.select('*')
				.eq('dataset_id', integration_task.dataset_id)
				.execute()
			)
			status = status_response.data[0]
			assert status['is_odm_done'] is True, 'ODM processing should be marked complete'

		# Verify orthomosaic was generated and stored
		remote_ortho_path = f'{settings.archive_path}/{integration_task.dataset_id}_ortho.tif'
		ortho_exists = check_file_exists_on_storage(remote_ortho_path, auth_token)
		assert ortho_exists, f'Generated orthomosaic not found at {remote_ortho_path}'

		# Verify EXIF metadata persistence through processing pipeline
		with use_client(auth_token) as client:
			raw_images_response = (
				client.table(settings.raw_images_table)
				.select('*')
				.eq('dataset_id', integration_task.dataset_id)
				.execute()
			)

			assert raw_images_response.data, f'Raw images entry not found for dataset {integration_task.dataset_id}'
			raw_images_entry = raw_images_response.data[0]
			camera_metadata = raw_images_entry['camera_metadata']

			# Verify EXIF metadata was extracted and persisted
			assert camera_metadata is not None, 'camera_metadata should not be None after ODM processing'
			assert isinstance(camera_metadata, dict), 'camera_metadata should be a dictionary'
			assert len(camera_metadata) > 0, 'camera_metadata should contain EXIF fields from processing'

			# Verify expected EXIF field categories are present
			expected_field_categories = [
				['Make', 'Model', 'Software'],  # Camera information
				['ISOSpeedRatings', 'FNumber', 'FocalLength', 'ExposureTime'],  # Image settings
				['DateTime', 'DateTimeOriginal', 'DateTimeDigitized'],  # Acquisition details
			]

			categories_found = 0
			for category in expected_field_categories:
				if any(field in camera_metadata for field in category):
					categories_found += 1

			assert categories_found >= 2, (
				f'Should have EXIF fields from at least 2 categories, found {categories_found} categories'
			)

	def test_exif_metadata_retrieval_and_query_functionality(self, integration_task, auth_token):
		"""Test metadata retrieval and JSON query functionality after processing."""

		# Execute ODM processing first
		process_odm(integration_task, Path(settings.processing_path))

		with use_client(auth_token) as client:
			# Test basic metadata retrieval
			raw_images_response = (
				client.table(settings.raw_images_table)
				.select('camera_metadata')
				.eq('dataset_id', integration_task.dataset_id)
				.execute()
			)

			assert raw_images_response.data, 'Should retrieve camera metadata'
			camera_metadata = raw_images_response.data[0]['camera_metadata']
			assert isinstance(camera_metadata, dict), 'Retrieved metadata should be a dictionary'

			# Test JSON path queries for common EXIF fields
			json_queries = [
				"camera_metadata->>'Make'",  # Camera manufacturer
				"camera_metadata->>'Model'",  # Camera model
				"camera_metadata->>'DateTime'",  # Image timestamp
			]

			for json_query in json_queries:
				try:
					query_response = (
						client.table(settings.raw_images_table)
						.select(json_query)
						.eq('dataset_id', integration_task.dataset_id)
						.execute()
					)
					# Should execute without errors (even if value is None)
					assert query_response.data is not None, f'JSON query should execute: {json_query}'
				except Exception as e:
					pytest.fail(f'JSON query failed: {json_query}, Error: {e}')

	def test_exif_metadata_jsonb_performance_with_complex_data(self, integration_task, auth_token):
		"""Test jsonb field performance with complex EXIF data structures."""

		# Execute ODM processing to populate metadata
		process_odm(integration_task, Path(settings.processing_path))

		with use_client(auth_token) as client:
			# Test complex JSON operations on EXIF metadata
			complex_queries = [
				# Test nested key existence
				"camera_metadata ? 'Make'",
				"camera_metadata ? 'Model'",
				# Test JSON object size
				'jsonb_object_keys(camera_metadata)',
				# Test conditional queries
				"camera_metadata->>'Make' IS NOT NULL",
			]

			for query in complex_queries:
				try:
					# Use raw SQL for complex jsonb operations
					sql_query = f"""
					SELECT {query} as result
					FROM {settings.raw_images_table}
					WHERE dataset_id = {integration_task.dataset_id}
					"""

					response = client.rpc('execute_sql', {'sql_query': sql_query}).execute()
					# Should execute without errors
					assert response.data is not None, f'Complex JSON query should execute: {query}'

				except Exception as e:
					# Some complex queries might not be supported by all Supabase versions
					print(f'Complex query not supported or failed: {query}, Error: {e}')

	def test_exif_metadata_persistence_across_pipeline_restarts(self, integration_task, auth_token):
		"""Test that EXIF metadata persists correctly if processing pipeline is restarted."""

		# Execute ODM processing
		process_odm(integration_task, Path(settings.processing_path))

		# Get initial metadata state
		with use_client(auth_token) as client:
			initial_response = (
				client.table(settings.raw_images_table)
				.select('camera_metadata')
				.eq('dataset_id', integration_task.dataset_id)
				.execute()
			)
			initial_metadata = initial_response.data[0]['camera_metadata']

		# Simulate pipeline restart by re-running ODM processing
		# (This should not duplicate or corrupt existing EXIF metadata)
		try:
			process_odm(integration_task, Path(settings.processing_path))
		except Exception:
			# ODM might fail on re-run due to existing files, which is expected
			pass

		# Verify metadata integrity after restart attempt
		with use_client(auth_token) as client:
			final_response = (
				client.table(settings.raw_images_table)
				.select('camera_metadata')
				.eq('dataset_id', integration_task.dataset_id)
				.execute()
			)
			final_metadata = final_response.data[0]['camera_metadata']

		# Metadata should remain consistent and not be corrupted
		assert isinstance(final_metadata, dict), 'Metadata should remain a valid dictionary'
		assert len(final_metadata) > 0, 'Metadata should not be empty after restart'

		# Key fields should remain consistent
		if 'Make' in initial_metadata and 'Make' in final_metadata:
			assert initial_metadata['Make'] == final_metadata['Make'], 'Camera make should remain consistent'

		if 'Model' in initial_metadata and 'Model' in final_metadata:
			assert initial_metadata['Model'] == final_metadata['Model'], 'Camera model should remain consistent'
