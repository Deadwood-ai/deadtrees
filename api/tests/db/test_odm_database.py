import pytest
from datetime import datetime
from shared.db import use_client
from shared.settings import settings
from shared.models import LicenseEnum, PlatformEnum, DatasetAccessEnum, StatusEnum, TaskTypeEnum


def test_v2_raw_images_table_exists(auth_token):
	"""Test that v2_raw_images table exists with correct structure"""
	with use_client(auth_token) as client:
		# Test table exists by trying to query it
		response = client.table('v2_raw_images').select('*').limit(1).execute()
		assert response.data is not None


def test_v2_raw_images_table_constraints(auth_token, test_user):
	"""Test v2_raw_images table constraints and field validation"""
	dataset_id = None

	try:
		with use_client(auth_token) as client:
			# First create a test dataset
			dataset_data = {
				'file_name': 'test-odm-constraints.zip',
				'user_id': test_user,
				'license': LicenseEnum.cc_by,
				'platform': PlatformEnum.drone,
				'authors': ['Test Author'],
				'data_access': DatasetAccessEnum.public,
			}
			dataset_response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = dataset_response.data[0]['id']

			# Test successful insert with all required fields
			raw_images_data = {
				'dataset_id': dataset_id,
				'raw_image_count': 15,
				'raw_image_size_mb': 250,
				'raw_images_path': f'raw_images/{dataset_id}/images/',
				'has_rtk_data': False,
				'rtk_file_count': 0,
			}

			response = client.table('v2_raw_images').insert(raw_images_data).execute()
			assert len(response.data) == 1
			raw_images_record = response.data[0]

			# Verify all fields are present and have correct values
			assert raw_images_record['dataset_id'] == dataset_id
			assert raw_images_record['raw_image_count'] == 15
			assert raw_images_record['raw_image_size_mb'] == 250
			assert raw_images_record['raw_images_path'] == f'raw_images/{dataset_id}/images/'
			assert raw_images_record['has_rtk_data'] is False
			assert raw_images_record['rtk_file_count'] == 0
			assert raw_images_record['version'] == 1  # Default value
			assert raw_images_record['created_at'] is not None

	finally:
		# Cleanup
		if dataset_id:
			with use_client(auth_token) as client:
				# Delete raw_images record first due to foreign key
				client.table('v2_raw_images').delete().eq('dataset_id', dataset_id).execute()
				# Delete dataset (this should cascade delete status)
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_v2_raw_images_with_rtk_data(auth_token, test_user):
	"""Test v2_raw_images table with RTK data fields"""
	dataset_id = None

	try:
		with use_client(auth_token) as client:
			# Create test dataset
			dataset_data = {
				'file_name': 'test-odm-rtk.zip',
				'user_id': test_user,
				'license': LicenseEnum.cc_by,
				'platform': PlatformEnum.drone,
				'authors': ['Test Author'],
				'data_access': DatasetAccessEnum.public,
			}
			dataset_response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = dataset_response.data[0]['id']

			# Test insert with RTK data
			camera_metadata = {
				'camera_model': 'DJI Mavic 3 Enterprise RTK',
				'focal_length': 24.0,
				'sensor_width': 13.2,
			}

			raw_images_data = {
				'dataset_id': dataset_id,
				'raw_image_count': 30,
				'raw_image_size_mb': 500,
				'raw_images_path': f'raw_images/{dataset_id}/images/',
				'camera_metadata': camera_metadata,
				'has_rtk_data': True,
				'rtk_precision_cm': 2.5,
				'rtk_quality_indicator': 8,
				'rtk_file_count': 5,
			}

			response = client.table('v2_raw_images').insert(raw_images_data).execute()
			assert len(response.data) == 1
			raw_images_record = response.data[0]

			# Verify RTK-specific fields
			assert raw_images_record['has_rtk_data'] is True
			assert float(raw_images_record['rtk_precision_cm']) == 2.5
			assert raw_images_record['rtk_quality_indicator'] == 8
			assert raw_images_record['rtk_file_count'] == 5
			assert raw_images_record['camera_metadata'] == camera_metadata

	finally:
		# Cleanup
		if dataset_id:
			with use_client(auth_token) as client:
				client.table('v2_raw_images').delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_v2_raw_images_foreign_key_constraint(auth_token):
	"""Test foreign key relationship with v2_datasets table"""
	with use_client(auth_token) as client:
		# Try to insert raw_images record with non-existent dataset_id
		raw_images_data = {
			'dataset_id': 999999,  # Non-existent dataset ID
			'raw_image_count': 10,
			'raw_image_size_mb': 100,
			'raw_images_path': 'raw_images/999999/images/',
		}

		# This should fail due to foreign key constraint
		with pytest.raises(Exception):
			client.table('v2_raw_images').insert(raw_images_data).execute()


def test_v2_raw_images_cascade_delete(auth_token, test_user):
	"""Test that deleting dataset cascades to delete raw_images record"""
	dataset_id = None

	try:
		with use_client(auth_token) as client:
			# Create test dataset
			dataset_data = {
				'file_name': 'test-cascade-delete.zip',
				'user_id': test_user,
				'license': LicenseEnum.cc_by,
				'platform': PlatformEnum.drone,
				'authors': ['Test Author'],
				'data_access': DatasetAccessEnum.public,
			}
			dataset_response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = dataset_response.data[0]['id']

			# Create raw_images record
			raw_images_data = {
				'dataset_id': dataset_id,
				'raw_image_count': 5,
				'raw_image_size_mb': 50,
				'raw_images_path': f'raw_images/{dataset_id}/images/',
			}
			client.table('v2_raw_images').insert(raw_images_data).execute()

			# Verify raw_images record exists
			raw_images_check = client.table('v2_raw_images').select('*').eq('dataset_id', dataset_id).execute()
			assert len(raw_images_check.data) == 1

			# Delete the dataset
			client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()

			# Verify raw_images record was cascade deleted
			raw_images_check_after = client.table('v2_raw_images').select('*').eq('dataset_id', dataset_id).execute()
			assert len(raw_images_check_after.data) == 0

			# Set dataset_id to None to prevent cleanup attempt
			dataset_id = None

	finally:
		# Cleanup if needed
		if dataset_id:
			with use_client(auth_token) as client:
				client.table('v2_raw_images').delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


# ============================================================================
# ODM Enum Extensions Tests
# ============================================================================


def test_odm_processing_in_status_enum(auth_token, test_user):
	"""Test that odm_processing value works in v2_status enum"""
	dataset_id = None

	try:
		with use_client(auth_token) as client:
			# Create test dataset
			dataset_data = {
				'file_name': 'test-status-enum.zip',
				'user_id': test_user,
				'license': LicenseEnum.cc_by,
				'platform': PlatformEnum.drone,
				'authors': ['Test Author'],
				'data_access': DatasetAccessEnum.public,
			}
			dataset_response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = dataset_response.data[0]['id']

			# Create status record with odm_processing status
			status_data = {
				'dataset_id': dataset_id,
				'current_status': StatusEnum.odm_processing,
			}

			response = client.table(settings.statuses_table).insert(status_data).execute()
			assert len(response.data) == 1
			status_record = response.data[0]

			# Verify enum value was accepted
			assert status_record['current_status'] == 'odm_processing'

	finally:
		# Cleanup
		if dataset_id:
			with use_client(auth_token) as client:
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_is_odm_done_field_in_statuses(auth_token, test_user):
	"""Test that is_odm_done field exists and works in v2_statuses table"""
	dataset_id = None

	try:
		with use_client(auth_token) as client:
			# Create test dataset
			dataset_data = {
				'file_name': 'test-odm-done-field.zip',
				'user_id': test_user,
				'license': LicenseEnum.cc_by,
				'platform': PlatformEnum.drone,
				'authors': ['Test Author'],
				'data_access': DatasetAccessEnum.public,
			}
			dataset_response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = dataset_response.data[0]['id']

			# Create status record with is_odm_done = True
			status_data = {
				'dataset_id': dataset_id,
				'current_status': StatusEnum.idle,
				'is_odm_done': True,
			}

			response = client.table(settings.statuses_table).insert(status_data).execute()
			assert len(response.data) == 1
			status_record = response.data[0]

			# Verify is_odm_done field exists and has correct value
			assert 'is_odm_done' in status_record
			assert status_record['is_odm_done'] is True

			# Test default value by creating another record without specifying is_odm_done
			status_data_2 = {
				'dataset_id': dataset_id,
				'current_status': StatusEnum.uploading,
			}

			# Delete first record to avoid unique constraint
			client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()

			response_2 = client.table(settings.statuses_table).insert(status_data_2).execute()
			status_record_2 = response_2.data[0]

			# Verify default value is False
			assert status_record_2['is_odm_done'] is False

	finally:
		# Cleanup
		if dataset_id:
			with use_client(auth_token) as client:
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_all_status_completion_flags_exist(auth_token, test_user):
	"""Test that all expected completion flags exist in v2_statuses table"""
	dataset_id = None

	try:
		with use_client(auth_token) as client:
			# Create test dataset
			dataset_data = {
				'file_name': 'test-completion-flags.zip',
				'user_id': test_user,
				'license': LicenseEnum.cc_by,
				'platform': PlatformEnum.drone,
				'authors': ['Test Author'],
				'data_access': DatasetAccessEnum.public,
			}
			dataset_response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = dataset_response.data[0]['id']

			# Create status record with all completion flags
			status_data = {
				'dataset_id': dataset_id,
				'current_status': StatusEnum.idle,
				'is_upload_done': True,
				'is_ortho_done': True,
				'is_cog_done': True,
				'is_thumbnail_done': True,
				'is_deadwood_done': True,
				'is_forest_cover_done': True,
				'is_metadata_done': True,
				'is_odm_done': True,
			}

			response = client.table(settings.statuses_table).insert(status_data).execute()
			assert len(response.data) == 1
			status_record = response.data[0]

			# Verify all expected completion flags exist
			expected_flags = [
				'is_upload_done',
				'is_ortho_done',
				'is_cog_done',
				'is_thumbnail_done',
				'is_deadwood_done',
				'is_forest_cover_done',
				'is_metadata_done',
				'is_odm_done',
			]

			for flag in expected_flags:
				assert flag in status_record
				assert status_record[flag] is True

	finally:
		# Cleanup
		if dataset_id:
			with use_client(auth_token) as client:
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()
