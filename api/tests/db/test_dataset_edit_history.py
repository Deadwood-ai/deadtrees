import pytest
from shared.db import use_client, login
from shared.settings import settings
from shared.models import LicenseEnum, PlatformEnum, DatasetAccessEnum
from shared.testing.fixtures import (
	test_file,
	cleanup_database,
	data_directory,
	test_processor_user,
)


@pytest.fixture(scope='function')
def test_dataset_for_editing(auth_token, test_user):
	"""Create a test dataset for editing operations"""
	dataset_id = None

	try:
		with use_client(auth_token) as client:
			# Create initial dataset with all editable fields
			dataset_data = {
				'file_name': 'test-edit-dataset.tif',
				'user_id': test_user,
				'license': LicenseEnum.cc_by,
				'platform': PlatformEnum.drone,
				'authors': ['Original Author', 'Co-Author'],
				'data_access': DatasetAccessEnum.public,
				'aquisition_year': 2023,
				'aquisition_month': 6,
				'aquisition_day': 15,
				'additional_information': 'Original additional information',
				'citation_doi': '10.1234/original.doi',
			}
			response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = response.data[0]['id']

			yield dataset_id

	finally:
		# Cleanup
		if dataset_id:
			with use_client(auth_token) as client:
				# Delete edit history first (foreign key constraint)
				client.table('v2_dataset_edit_history').delete().eq('dataset_id', dataset_id).execute()
				# Delete the dataset
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


@pytest.fixture(scope='function')
def test_dataset_for_other_user(auth_token, test_user2):
	"""Create a test dataset owned by another user"""
	dataset_id = None

	try:
		with use_client(auth_token) as client:
			# Create dataset owned by test_user2
			dataset_data = {
				'file_name': 'test-other-user-dataset.tif',
				'user_id': test_user2,
				'license': LicenseEnum.cc_by,
				'platform': PlatformEnum.drone,
				'authors': ['Other User'],
				'data_access': DatasetAccessEnum.public,
				'aquisition_year': 2023,
				'aquisition_month': 1,
				'aquisition_day': 1,
			}
			response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = response.data[0]['id']

			yield dataset_id

	finally:
		# Cleanup
		if dataset_id:
			with use_client(auth_token) as client:
				client.table('v2_dataset_edit_history').delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_dataset_edit_history_table_exists():
	"""Test that the v2_dataset_edit_history table exists and is accessible"""
	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)

	with use_client(processor_token) as client:
		# Should be able to query the table without error
		response = client.table('v2_dataset_edit_history').select('*').limit(1).execute()
		assert response.data is not None


def test_dataset_update_authors_field(auth_token, test_user, test_dataset_for_editing):
	"""Test updating the authors field and verify edit history is logged"""
	with use_client(auth_token) as client:
		# Update authors field
		new_authors = ['Updated Author', 'New Co-Author', 'Third Author']
		update_data = {'authors': new_authors}

		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None
		assert len(response.data) == 1
		assert response.data[0]['authors'] == new_authors

		# Verify edit history was created
		history_response = (
			client.table('v2_dataset_edit_history').select('*').eq('dataset_id', test_dataset_for_editing).execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 1

		history_entry = history_response.data[0]
		assert history_entry['field_name'] == 'authors'
		assert history_entry['user_id'] == test_user
		assert history_entry['old_value'] == ['Original Author', 'Co-Author']
		assert history_entry['new_value'] == new_authors
		assert history_entry['change_type'] == 'UPDATE'


def test_dataset_update_acquisition_year(auth_token, test_user, test_dataset_for_editing):
	"""Test updating the acquisition year field"""
	with use_client(auth_token) as client:
		# Update acquisition year
		new_year = 2024
		update_data = {'aquisition_year': new_year}

		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None
		assert response.data[0]['aquisition_year'] == new_year

		# Verify edit history
		history_response = (
			client.table('v2_dataset_edit_history')
			.select('*')
			.eq('dataset_id', test_dataset_for_editing)
			.eq('field_name', 'aquisition_year')
			.execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 1

		history_entry = history_response.data[0]
		assert history_entry['old_value'] == 2023
		assert history_entry['new_value'] == new_year


def test_dataset_update_acquisition_month(auth_token, test_user, test_dataset_for_editing):
	"""Test updating the acquisition month field"""
	with use_client(auth_token) as client:
		# Update acquisition month
		new_month = 12
		update_data = {'aquisition_month': new_month}

		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None
		assert response.data[0]['aquisition_month'] == new_month

		# Verify edit history
		history_response = (
			client.table('v2_dataset_edit_history')
			.select('*')
			.eq('dataset_id', test_dataset_for_editing)
			.eq('field_name', 'aquisition_month')
			.execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 1

		history_entry = history_response.data[0]
		assert history_entry['old_value'] == 6
		assert history_entry['new_value'] == new_month


def test_dataset_update_acquisition_day(auth_token, test_user, test_dataset_for_editing):
	"""Test updating the acquisition day field"""
	with use_client(auth_token) as client:
		# Update acquisition day
		new_day = 25
		update_data = {'aquisition_day': new_day}

		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None
		assert response.data[0]['aquisition_day'] == new_day

		# Verify edit history
		history_response = (
			client.table('v2_dataset_edit_history')
			.select('*')
			.eq('dataset_id', test_dataset_for_editing)
			.eq('field_name', 'aquisition_day')
			.execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 1

		history_entry = history_response.data[0]
		assert history_entry['old_value'] == 15
		assert history_entry['new_value'] == new_day


def test_dataset_update_platform(auth_token, test_user, test_dataset_for_editing):
	"""Test updating the platform field"""
	with use_client(auth_token) as client:
		# Update platform
		new_platform = PlatformEnum.satellite
		update_data = {'platform': new_platform}

		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None
		assert response.data[0]['platform'] == new_platform

		# Verify edit history
		history_response = (
			client.table('v2_dataset_edit_history')
			.select('*')
			.eq('dataset_id', test_dataset_for_editing)
			.eq('field_name', 'platform')
			.execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 1

		history_entry = history_response.data[0]
		assert history_entry['old_value'] == PlatformEnum.drone.value
		assert history_entry['new_value'] == new_platform.value


def test_dataset_update_citation_doi(auth_token, test_user, test_dataset_for_editing):
	"""Test updating the citation DOI field"""
	with use_client(auth_token) as client:
		# Update citation DOI
		new_doi = '10.5281/zenodo.updated.doi'
		update_data = {'citation_doi': new_doi}

		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None
		assert response.data[0]['citation_doi'] == new_doi

		# Verify edit history
		history_response = (
			client.table('v2_dataset_edit_history')
			.select('*')
			.eq('dataset_id', test_dataset_for_editing)
			.eq('field_name', 'citation_doi')
			.execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 1

		history_entry = history_response.data[0]
		assert history_entry['old_value'] == '10.1234/original.doi'
		assert history_entry['new_value'] == new_doi


def test_dataset_update_additional_information(auth_token, test_user, test_dataset_for_editing):
	"""Test updating the additional information field"""
	with use_client(auth_token) as client:
		# Update additional information
		new_info = 'Updated additional information with more details about the dataset'
		update_data = {'additional_information': new_info}

		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None
		assert response.data[0]['additional_information'] == new_info

		# Verify edit history
		history_response = (
			client.table('v2_dataset_edit_history')
			.select('*')
			.eq('dataset_id', test_dataset_for_editing)
			.eq('field_name', 'additional_information')
			.execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 1

		history_entry = history_response.data[0]
		assert history_entry['old_value'] == 'Original additional information'
		assert history_entry['new_value'] == new_info


def test_dataset_update_multiple_fields(auth_token, test_user, test_dataset_for_editing):
	"""Test updating multiple fields at once and verify all changes are logged"""
	with use_client(auth_token) as client:
		# Update multiple fields at once
		update_data = {
			'authors': ['Multi-Update Author'],
			'aquisition_year': 2025,
			'platform': PlatformEnum.airborne,
			'citation_doi': '10.1234/multi.update',
		}

		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None

		# Verify all fields were updated
		updated_dataset = response.data[0]
		assert updated_dataset['authors'] == ['Multi-Update Author']
		assert updated_dataset['aquisition_year'] == 2025
		assert updated_dataset['platform'] == PlatformEnum.airborne
		assert updated_dataset['citation_doi'] == '10.1234/multi.update'

		# Verify edit history entries were created for each field
		history_response = (
			client.table('v2_dataset_edit_history').select('*').eq('dataset_id', test_dataset_for_editing).execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 4  # 4 fields updated

		# Check that all expected fields have history entries
		field_names = [entry['field_name'] for entry in history_response.data]
		expected_fields = ['authors', 'aquisition_year', 'platform', 'citation_doi']
		assert set(field_names) == set(expected_fields)


def test_dataset_update_null_values(auth_token, test_user, test_dataset_for_editing):
	"""Test updating fields to null values"""
	with use_client(auth_token) as client:
		# Update optional fields to null
		update_data = {
			'aquisition_month': None,
			'aquisition_day': None,
			'citation_doi': None,
			'additional_information': None,
		}

		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None

		# Verify fields were set to null
		updated_dataset = response.data[0]
		assert updated_dataset['aquisition_month'] is None
		assert updated_dataset['aquisition_day'] is None
		assert updated_dataset['citation_doi'] is None
		assert updated_dataset['additional_information'] is None

		# Verify edit history captured the null values
		history_response = (
			client.table('v2_dataset_edit_history').select('*').eq('dataset_id', test_dataset_for_editing).execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 4

		# Check that old values are preserved and new values are null
		for entry in history_response.data:
			assert entry['old_value'] is not None  # Original values existed
			assert entry['new_value'] is None  # New values are null


def test_dataset_update_with_processor_user(test_dataset_for_editing):
	"""Test that processor user can update datasets"""
	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)

	with use_client(processor_token) as client:
		# Processor should be able to update any dataset
		update_data = {'authors': ['Processor Updated Author']}

		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None
		assert response.data[0]['authors'] == ['Processor Updated Author']

		# Verify edit history was created (processor user should be recorded)
		history_response = (
			client.table('v2_dataset_edit_history').select('*').eq('dataset_id', test_dataset_for_editing).execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 1


def test_dataset_update_unauthorized_user(auth_token, test_user, test_dataset_for_other_user):
	"""Test that users cannot update datasets they don't own"""
	with use_client(auth_token) as client:
		# Try to update dataset owned by another user
		update_data = {'authors': ['Unauthorized Update']}

		# This should fail due to RLS policy
		try:
			response = (
				client.table(settings.datasets_table)
				.update(update_data)
				.eq('id', test_dataset_for_other_user)
				.execute()
			)
			# If it doesn't raise an exception, check that no rows were affected
			assert response.data is None or len(response.data) == 0
		except Exception:
			# Expected - RLS should prevent this update
			pass

		# Verify no edit history was created
		history_response = (
			client.table('v2_dataset_edit_history').select('*').eq('dataset_id', test_dataset_for_other_user).execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 0


def test_edit_history_timestamps(auth_token, test_user, test_dataset_for_editing):
	"""Test that edit history entries have proper timestamps"""
	import time

	with use_client(auth_token) as client:
		# Record time before update
		before_update = time.time()

		# Update dataset
		update_data = {'authors': ['Timestamp Test Author']}
		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None

		# Record time after update
		after_update = time.time()

		# Check edit history timestamp
		history_response = (
			client.table('v2_dataset_edit_history').select('*').eq('dataset_id', test_dataset_for_editing).execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 1

		history_entry = history_response.data[0]
		assert 'changed_at' in history_entry
		assert history_entry['changed_at'] is not None

		# Parse timestamp and verify it's within expected range
		from datetime import datetime

		changed_at = datetime.fromisoformat(history_entry['changed_at'].replace('Z', '+00:00'))
		changed_at_timestamp = changed_at.timestamp()

		assert before_update <= changed_at_timestamp <= after_update


def test_edit_history_foreign_key_constraints(auth_token, test_user, test_dataset_for_editing):
	"""Test that edit history entries are properly linked via foreign keys"""
	with use_client(auth_token) as client:
		# Update dataset to create history entry
		update_data = {'authors': ['Foreign Key Test Author']}
		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None

		# Verify history entry exists
		history_response = (
			client.table('v2_dataset_edit_history').select('*').eq('dataset_id', test_dataset_for_editing).execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 1

		history_entry = history_response.data[0]
		assert history_entry['dataset_id'] == test_dataset_for_editing
		assert history_entry['user_id'] == test_user

		# Verify foreign key relationships work
		# Check dataset exists
		dataset_response = (
			client.table(settings.datasets_table).select('*').eq('id', test_dataset_for_editing).execute()
		)
		assert dataset_response.data is not None
		assert len(dataset_response.data) == 1

		# Check user exists by verifying the foreign key constraint works
	# We can't directly access auth.users table, but the foreign key constraint
	# ensures the user_id exists, so if the history entry was created successfully,
	# the user must exist
	assert history_entry['user_id'] == test_user


def test_edit_history_cascade_deletion(auth_token, test_user):
	"""Test that edit history entries are deleted when dataset is deleted"""
	dataset_id = None

	try:
		with use_client(auth_token) as client:
			# Create a dataset
			dataset_data = {
				'file_name': 'test-cascade-delete.tif',
				'user_id': test_user,
				'license': LicenseEnum.cc_by,
				'platform': PlatformEnum.drone,
				'authors': ['Cascade Test Author'],
				'data_access': DatasetAccessEnum.public,
			}
			response = client.table(settings.datasets_table).insert(dataset_data).execute()
			dataset_id = response.data[0]['id']

			# Update dataset to create history entry
			update_data = {'authors': ['Updated Cascade Author']}
			client.table(settings.datasets_table).update(update_data).eq('id', dataset_id).execute()

			# Verify history entry exists
			history_response = (
				client.table('v2_dataset_edit_history').select('*').eq('dataset_id', dataset_id).execute()
			)
			assert history_response.data is not None
			assert len(history_response.data) == 1

			# Delete the dataset
			client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()

			# Verify history entry was also deleted (CASCADE)
			history_response = (
				client.table('v2_dataset_edit_history').select('*').eq('dataset_id', dataset_id).execute()
			)
			assert history_response.data is not None
			assert len(history_response.data) == 0

			dataset_id = None  # Mark as cleaned up

	finally:
		# Cleanup in case test failed
		if dataset_id:
			with use_client(auth_token) as client:
				client.table('v2_dataset_edit_history').delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_edit_history_query_by_user(auth_token, test_user, test_dataset_for_editing):
	"""Test querying edit history by user"""
	with use_client(auth_token) as client:
		# Create multiple edits by the same user
		updates = [
			{'authors': ['First Update']},
			{'aquisition_year': 2024},
			{'platform': PlatformEnum.satellite},
		]

		for update_data in updates:
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()

		# Query edit history by user
		history_response = client.table('v2_dataset_edit_history').select('*').eq('user_id', test_user).execute()
		assert history_response.data is not None
		assert len(history_response.data) == 3

		# Verify all entries are for the same user
		for entry in history_response.data:
			assert entry['user_id'] == test_user
			assert entry['dataset_id'] == test_dataset_for_editing


def test_edit_history_query_by_dataset(auth_token, test_user, test_dataset_for_editing):
	"""Test querying edit history by dataset"""
	with use_client(auth_token) as client:
		# Create multiple edits for the same dataset
		updates = [
			{'authors': ['Dataset Query Test 1']},
			{'aquisition_year': 2025},
			{'citation_doi': '10.1234/dataset.query'},
		]

		for update_data in updates:
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()

		# Query edit history by dataset
		history_response = (
			client.table('v2_dataset_edit_history').select('*').eq('dataset_id', test_dataset_for_editing).execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 3

		# Verify all entries are for the same dataset
		for entry in history_response.data:
			assert entry['dataset_id'] == test_dataset_for_editing
			assert entry['user_id'] == test_user


def test_edit_history_change_type_field(auth_token, test_user, test_dataset_for_editing):
	"""Test that change_type field is properly set"""
	with use_client(auth_token) as client:
		# Update dataset
		update_data = {'authors': ['Change Type Test']}
		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None

		# Verify change_type is set to 'UPDATE'
		history_response = (
			client.table('v2_dataset_edit_history').select('*').eq('dataset_id', test_dataset_for_editing).execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 1

		history_entry = history_response.data[0]
		assert history_entry['change_type'] == 'UPDATE'


def test_edit_history_jsonb_data_types(auth_token, test_user, test_dataset_for_editing):
	"""Test that old_value and new_value are properly stored as JSONB"""
	with use_client(auth_token) as client:
		# Update with complex data (array)
		new_authors = ['JSONB Test Author 1', 'JSONB Test Author 2']
		update_data = {'authors': new_authors}

		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None

		# Verify JSONB storage
		history_response = (
			client.table('v2_dataset_edit_history').select('*').eq('dataset_id', test_dataset_for_editing).execute()
		)
		assert history_response.data is not None
		assert len(history_response.data) == 1

		history_entry = history_response.data[0]

		# old_value should be the original array
		assert isinstance(history_entry['old_value'], list)
		assert history_entry['old_value'] == ['Original Author', 'Co-Author']

		# new_value should be the updated array
		assert isinstance(history_entry['new_value'], list)
		assert history_entry['new_value'] == new_authors


def test_no_edit_history_for_unchanged_fields(auth_token, test_user, test_dataset_for_editing):
	"""Test that no edit history is created when fields are not actually changed"""
	with use_client(auth_token) as client:
		# Get current dataset state
		current_response = (
			client.table(settings.datasets_table).select('*').eq('id', test_dataset_for_editing).execute()
		)
		current_dataset = current_response.data[0]

		# "Update" with the same values
		update_data = {
			'authors': current_dataset['authors'],
			'aquisition_year': current_dataset['aquisition_year'],
			'platform': current_dataset['platform'],
		}

		response = (
			client.table(settings.datasets_table).update(update_data).eq('id', test_dataset_for_editing).execute()
		)
		assert response.data is not None

		# Verify no edit history was created (values didn't actually change)
		history_response = (
			client.table('v2_dataset_edit_history').select('*').eq('dataset_id', test_dataset_for_editing).execute()
		)
		assert history_response.data is not None
		# Should be empty since no actual changes were made
		assert len(history_response.data) == 0
