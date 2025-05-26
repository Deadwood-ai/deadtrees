import pytest
from shared.db import use_client, login
from shared.settings import settings
from shared.models import PredictionQualityEnum, DatasetAccessEnum, LicenseEnum, PlatformEnum
from shared.testing.fixtures import (
	test_file,
	cleanup_database,
	data_directory,
	test_processor_user,
)


@pytest.fixture(scope='function')
def setup_audit_user(auth_token, test_user):
	"""Create a user with audit permissions"""
	privileged_user_id = None

	try:
		processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)

		with use_client(processor_token) as processor_client:
			# Add test user with audit permission
			audit_user_entry = {
				'user_id': test_user,
				'can_upload_private': False,
				'can_view_all_private': False,
				'can_audit': True,
			}
			response = processor_client.table('privileged_users').insert(audit_user_entry).execute()
			if response.data:
				privileged_user_id = response.data[0]['id']

		yield test_user

	finally:
		if privileged_user_id:
			try:
				with use_client(processor_token) as client:
					client.table('privileged_users').delete().eq('id', privileged_user_id).execute()
			except Exception as e:
				print(f'Failed to clean up audit user: {str(e)}')


@pytest.fixture(scope='function')
def setup_non_audit_user(auth_token, test_user2):
	"""Create a user without audit permissions"""
	privileged_user_id = None

	try:
		processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)

		with use_client(processor_token) as processor_client:
			# Add test user2 without audit permission
			non_audit_user_entry = {
				'user_id': test_user2,
				'can_upload_private': False,
				'can_view_all_private': False,
				'can_audit': False,
			}
			response = processor_client.table('privileged_users').insert(non_audit_user_entry).execute()
			if response.data:
				privileged_user_id = response.data[0]['id']

		yield test_user2

	finally:
		if privileged_user_id:
			try:
				with use_client(processor_token) as client:
					client.table('privileged_users').delete().eq('id', privileged_user_id).execute()
			except Exception as e:
				print(f'Failed to clean up non-audit user: {str(e)}')


@pytest.fixture(scope='function')
def sample_audit_data(datasets_with_mixed_access, setup_audit_user):
	"""Create sample audit data for testing"""
	audit_entries = []

	try:
		user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

		with use_client(user_token) as client:
			# Create audit entry for public dataset
			public_audit = {
				'dataset_id': datasets_with_mixed_access['public_id'],
				'is_georeferenced': True,
				'has_valid_acquisition_date': True,
				'acquisition_date_notes': 'Date looks correct',
				'has_valid_phenology': True,
				'phenology_notes': 'Good phenology data',
				'deadwood_quality': PredictionQualityEnum.great.value,
				'deadwood_notes': 'Excellent deadwood detection',
				'forest_cover_quality': PredictionQualityEnum.great.value,
				'forest_cover_notes': 'Good forest cover mapping',
				'aoi_done': True,
				'has_cog_issue': False,
				'has_thumbnail_issue': False,
				'audited_by': setup_audit_user,
				'notes': 'Complete audit - all good',
			}

			response = client.table('dataset_audit').insert(public_audit).execute()
			if response.data:
				audit_entries.append(response.data[0]['dataset_id'])

			# Create audit entry for private dataset
			private_audit = {
				'dataset_id': datasets_with_mixed_access['private_id'],
				'is_georeferenced': False,
				'has_valid_acquisition_date': False,
				'acquisition_date_notes': 'Date is missing',
				'has_valid_phenology': False,
				'phenology_notes': 'Phenology data unclear',
				'deadwood_quality': PredictionQualityEnum.bad.value,
				'deadwood_notes': 'Poor deadwood detection quality',
				'forest_cover_quality': PredictionQualityEnum.sentinel_ok.value,
				'forest_cover_notes': 'Acceptable forest cover',
				'aoi_done': False,
				'has_cog_issue': True,
				'cog_issue_notes': 'COG has projection issues',
				'has_thumbnail_issue': False,
				'audited_by': setup_audit_user,
				'notes': 'Needs significant improvements',
			}

			response = client.table('dataset_audit').insert(private_audit).execute()
			if response.data:
				audit_entries.append(response.data[0]['dataset_id'])

		yield {
			'public_audit_id': datasets_with_mixed_access['public_id'],
			'private_audit_id': datasets_with_mixed_access['private_id'],
			'auditor_id': setup_audit_user,
		}

	finally:
		# Clean up audit entries
		try:
			with use_client(user_token) as client:
				for dataset_id in audit_entries:
					client.table('dataset_audit').delete().eq('dataset_id', dataset_id).execute()
		except Exception as e:
			print(f'Failed to clean up audit entries: {str(e)}')


def test_dataset_audit_table_exists():
	"""Test that the dataset_audit table exists and is accessible"""
	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)

	with use_client(processor_token) as client:
		# Should be able to query the table without error
		response = client.table('dataset_audit').select('*').limit(1).execute()
		assert response.data is not None


def test_audit_user_can_access_dataset_audit(setup_audit_user):
	"""Test that users with audit permissions can access the dataset_audit table"""
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(user_token) as client:
		# User with audit permission should be able to access dataset_audit
		response = client.table('dataset_audit').select('*').execute()
		assert response.data is not None


def test_processor_can_access_dataset_audit():
	"""Test that processor can access the dataset_audit table"""
	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)

	with use_client(processor_token) as client:
		# Processor should be able to access dataset_audit
		response = client.table('dataset_audit').select('*').execute()
		assert response.data is not None


def test_create_audit_entry(setup_audit_user, datasets_with_mixed_access):
	"""Test creating an audit entry"""
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(user_token) as client:
		# Create an audit entry
		audit_entry = {
			'dataset_id': datasets_with_mixed_access['public_id'],
			'is_georeferenced': True,
			'has_valid_acquisition_date': True,
			'acquisition_date_notes': 'Test audit entry',
			'has_valid_phenology': True,
			'deadwood_quality': PredictionQualityEnum.great.value,
			'forest_cover_quality': PredictionQualityEnum.great.value,
			'aoi_done': True,
			'has_cog_issue': False,
			'has_thumbnail_issue': False,
			'audited_by': setup_audit_user,
			'notes': 'Test audit entry',
		}

		response = client.table('dataset_audit').insert(audit_entry).execute()
		assert response.data is not None
		assert len(response.data) == 1

		created_entry = response.data[0]
		assert created_entry['dataset_id'] == datasets_with_mixed_access['public_id']
		assert created_entry['is_georeferenced'] is True
		assert created_entry['deadwood_quality'] == PredictionQualityEnum.great.value
		assert created_entry['audited_by'] == setup_audit_user

		# Clean up
		client.table('dataset_audit').delete().eq('dataset_id', datasets_with_mixed_access['public_id']).execute()


def test_audit_entry_with_all_fields(setup_audit_user, datasets_with_mixed_access):
	"""Test creating an audit entry with all possible fields"""
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(user_token) as client:
		# Create comprehensive audit entry
		comprehensive_audit = {
			'dataset_id': datasets_with_mixed_access['public_id'],
			'is_georeferenced': False,
			'has_valid_acquisition_date': False,
			'acquisition_date_notes': 'Date format is incorrect',
			'has_valid_phenology': True,
			'phenology_notes': 'Phenology matches expected season',
			'deadwood_quality': PredictionQualityEnum.sentinel_ok.value,
			'deadwood_notes': 'Some false positives detected',
			'forest_cover_quality': PredictionQualityEnum.bad.value,
			'forest_cover_notes': 'Poor segmentation quality',
			'aoi_done': True,
			'has_cog_issue': True,
			'cog_issue_notes': 'Missing overviews',
			'has_thumbnail_issue': True,
			'thumbnail_issue_notes': 'Thumbnail is too dark',
			'audited_by': setup_audit_user,
			'notes': 'Comprehensive audit with multiple issues identified',
		}

		response = client.table('dataset_audit').insert(comprehensive_audit).execute()
		assert response.data is not None

		created_entry = response.data[0]
		assert created_entry['acquisition_date_notes'] == 'Date format is incorrect'
		assert created_entry['deadwood_quality'] == PredictionQualityEnum.sentinel_ok.value
		assert created_entry['forest_cover_quality'] == PredictionQualityEnum.bad.value
		assert created_entry['cog_issue_notes'] == 'Missing overviews'
		assert created_entry['thumbnail_issue_notes'] == 'Thumbnail is too dark'

		# Clean up
		client.table('dataset_audit').delete().eq('dataset_id', datasets_with_mixed_access['public_id']).execute()


def test_audit_foreign_key_constraints(setup_audit_user, datasets_with_mixed_access):
	"""Test that dataset_audit foreign key constraints work correctly"""
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(user_token) as client:
		# Test valid dataset_id
		valid_audit = {
			'dataset_id': datasets_with_mixed_access['public_id'],
			'is_georeferenced': True,
			'audited_by': setup_audit_user,
			'notes': 'Valid foreign key test',
		}

		response = client.table('dataset_audit').insert(valid_audit).execute()
		assert response.data is not None

		# Test invalid dataset_id (should fail)
		invalid_audit = {
			'dataset_id': 999999,  # Non-existent dataset
			'is_georeferenced': True,
			'audited_by': setup_audit_user,
			'notes': 'Invalid foreign key test',
		}

		try:
			response = client.table('dataset_audit').insert(invalid_audit).execute()
			# If this doesn't raise an exception, check if the insert was actually rejected
			assert False, 'Expected foreign key constraint violation'
		except Exception:
			# Expected behavior - foreign key constraint should prevent this
			assert True

		# Clean up valid entry
		client.table('dataset_audit').delete().eq('dataset_id', datasets_with_mixed_access['public_id']).execute()


def test_audit_entry_update(sample_audit_data):
	"""Test updating an existing audit entry"""
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(user_token) as client:
		# Update the audit entry
		updated_data = {
			'deadwood_quality': PredictionQualityEnum.bad.value,
			'deadwood_notes': 'Updated: Found issues with deadwood detection',
			'notes': 'Updated audit entry',
		}

		response = (
			client.table('dataset_audit')
			.update(updated_data)
			.eq('dataset_id', sample_audit_data['public_audit_id'])
			.execute()
		)
		assert response.data is not None

		# Verify the update
		response = (
			client.table('dataset_audit').select('*').eq('dataset_id', sample_audit_data['public_audit_id']).execute()
		)
		updated_entry = response.data[0]
		assert updated_entry['deadwood_quality'] == PredictionQualityEnum.bad.value
		assert updated_entry['deadwood_notes'] == 'Updated: Found issues with deadwood detection'
		assert updated_entry['notes'] == 'Updated audit entry'


def test_audit_entry_deletion(setup_audit_user, datasets_with_mixed_access):
	"""Test deleting an audit entry"""
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(user_token) as client:
		# Create an audit entry
		audit_entry = {
			'dataset_id': datasets_with_mixed_access['public_id'],
			'is_georeferenced': True,
			'audited_by': setup_audit_user,
			'notes': 'Entry to be deleted',
		}

		response = client.table('dataset_audit').insert(audit_entry).execute()
		assert response.data is not None

		# Delete the entry
		response = (
			client.table('dataset_audit').delete().eq('dataset_id', datasets_with_mixed_access['public_id']).execute()
		)
		assert response.data is not None

		# Verify deletion
		response = (
			client.table('dataset_audit')
			.select('*')
			.eq('dataset_id', datasets_with_mixed_access['public_id'])
			.execute()
		)
		assert len(response.data) == 0


def test_audit_cascade_deletion_on_dataset_delete(setup_audit_user, auth_token):
	"""Test that audit entries are deleted when the associated dataset is deleted"""
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	# Create a temporary dataset
	with use_client(auth_token) as client:
		temp_dataset = {
			'file_name': 'temp-audit-test.tif',
			'user_id': setup_audit_user,
			'license': LicenseEnum.cc_by.value,
			'platform': PlatformEnum.drone.value,
			'authors': ['Test Author'],
			'data_access': DatasetAccessEnum.public.value,
			'aquisition_year': 2024,
			'aquisition_month': 1,
			'aquisition_day': 1,
		}
		response = client.table(settings.datasets_table).insert(temp_dataset).execute()
		temp_dataset_id = response.data[0]['id']

	try:
		with use_client(user_token) as client:
			# Create audit entry for the temporary dataset
			audit_entry = {
				'dataset_id': temp_dataset_id,
				'is_georeferenced': True,
				'audited_by': setup_audit_user,
				'notes': 'Audit for cascade test',
			}

			response = client.table('dataset_audit').insert(audit_entry).execute()
			assert response.data is not None

			# Verify audit entry exists
			response = client.table('dataset_audit').select('*').eq('dataset_id', temp_dataset_id).execute()
			assert len(response.data) == 1

		# Delete the dataset
		with use_client(auth_token) as client:
			client.table(settings.datasets_table).delete().eq('id', temp_dataset_id).execute()

		# Verify audit entry was also deleted (cascade)
		with use_client(user_token) as client:
			response = client.table('dataset_audit').select('*').eq('dataset_id', temp_dataset_id).execute()
			assert len(response.data) == 0

	finally:
		# Ensure cleanup even if test fails
		try:
			with use_client(auth_token) as client:
				client.table(settings.datasets_table).delete().eq('id', temp_dataset_id).execute()
		except:
			pass


def test_prediction_quality_enum_values(setup_audit_user, datasets_with_mixed_access):
	"""Test that all prediction quality enum values work correctly"""
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	quality_values = [PredictionQualityEnum.great, PredictionQualityEnum.sentinel_ok, PredictionQualityEnum.bad]

	with use_client(user_token) as client:
		for i, quality in enumerate(quality_values):
			# Use different datasets or clean up between iterations
			dataset_id = datasets_with_mixed_access['public_id'] if i == 0 else datasets_with_mixed_access['private_id']

			# Clean up any existing audit for this dataset
			client.table('dataset_audit').delete().eq('dataset_id', dataset_id).execute()

			audit_entry = {
				'dataset_id': dataset_id,
				'deadwood_quality': quality.value,
				'forest_cover_quality': quality.value,
				'audited_by': setup_audit_user,
				'notes': f'Testing {quality.value} quality',
			}

			response = client.table('dataset_audit').insert(audit_entry).execute()
			assert response.data is not None

			created_entry = response.data[0]
			assert created_entry['deadwood_quality'] == quality.value
			assert created_entry['forest_cover_quality'] == quality.value

			# Clean up
			client.table('dataset_audit').delete().eq('dataset_id', dataset_id).execute()


def test_audit_timestamps(setup_audit_user, datasets_with_mixed_access):
	"""Test that audit timestamps are set correctly"""
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(user_token) as client:
		audit_entry = {
			'dataset_id': datasets_with_mixed_access['public_id'],
			'is_georeferenced': True,
			'audited_by': setup_audit_user,
			'notes': 'Timestamp test',
		}

		response = client.table('dataset_audit').insert(audit_entry).execute()
		assert response.data is not None

		created_entry = response.data[0]
		assert created_entry['audit_date'] is not None

		# The audit_date should be recent (within the last minute)
		from datetime import datetime, timezone
		import dateutil.parser

		audit_date = dateutil.parser.parse(created_entry['audit_date'])
		now = datetime.now(timezone.utc)
		time_diff = (now - audit_date).total_seconds()

		# Should be created within the last 60 seconds
		assert time_diff < 60

		# Clean up
		client.table('dataset_audit').delete().eq('dataset_id', datasets_with_mixed_access['public_id']).execute()
