import pytest
from shared.db import use_client, login
from shared.settings import settings
import uuid
from shared.testing.fixtures import test_processor_user


@pytest.fixture(scope='function')
def setup_privileged_users(auth_token, test_user, test_processor_user):
	"""Create test entries in the privileged_users table"""
	privileged_user_ids = []

	try:
		# Get processor token for all operations
		processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)

		# Create entries for both test user and processor
		with use_client(processor_token) as processor_client:
			# Add test user to privileged users with all permissions
			test_user_entry = {
				'user_id': test_user,
				'can_upload_private': True,
				'can_view_all_private': True,
				'can_audit': True,
			}
			response = processor_client.table('privileged_users').insert(test_user_entry).execute()
			if response.data:
				privileged_user_ids.append(response.data[0]['id'])

			# Always add processor to privileged users with all permissions
			if test_processor_user:
				# First check if processor already exists
				existing = (
					processor_client.table('privileged_users').select('*').eq('user_id', test_processor_user).execute()
				)

				if not existing.data:
					processor_entry = {
						'user_id': test_processor_user,
						'can_upload_private': True,
						'can_view_all_private': True,
						'can_audit': True,
					}
					response = processor_client.table('privileged_users').insert(processor_entry).execute()
					if response.data:
						privileged_user_ids.append(response.data[0]['id'])
				else:
					# Update existing entry
					processor_client.table('privileged_users').update(
						{
							'can_upload_private': True,
							'can_view_all_private': True,
							'can_audit': True,
						}
					).eq('user_id', test_processor_user).execute()

		yield {
			'test_user_id': test_user,
			'processor_id': test_processor_user,
			'entry_ids': privileged_user_ids,
		}

	finally:
		# Clean up entries using processor token (but don't remove processor's privileges)
		try:
			with use_client(processor_token) as client:
				for entry_id in privileged_user_ids:
					# Only delete test user entries, not processor entries
					entry = client.table('privileged_users').select('user_id').eq('id', entry_id).execute()
					if entry.data and entry.data[0]['user_id'] != test_processor_user:
						client.table('privileged_users').delete().eq('id', entry_id).execute()
		except Exception as e:
			print(f'Failed to clean up privileged users: {str(e)}')


@pytest.fixture(scope='function')
def setup_privileged_users_with_limited_permissions(auth_token, test_user, test_user2):
	"""Create test entries with different permission levels"""
	privileged_user_ids = []

	try:
		processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)

		with use_client(processor_token) as processor_client:
			# Add test_user with view_all_private permission only
			test_user_entry = {
				'user_id': test_user,
				'can_upload_private': False,
				'can_view_all_private': True,
				'can_audit': False,
			}
			response = processor_client.table('privileged_users').insert(test_user_entry).execute()
			if response.data:
				privileged_user_ids.append(response.data[0]['id'])

			# Add test_user2 with audit permission only
			test_user2_entry = {
				'user_id': test_user2,
				'can_upload_private': False,
				'can_view_all_private': False,
				'can_audit': True,
			}
			response = processor_client.table('privileged_users').insert(test_user2_entry).execute()
			if response.data:
				privileged_user_ids.append(response.data[0]['id'])

		yield {
			'view_private_user_id': test_user,
			'audit_user_id': test_user2,
			'entry_ids': privileged_user_ids,
		}

	finally:
		try:
			with use_client(processor_token) as client:
				for entry_id in privileged_user_ids:
					client.table('privileged_users').delete().eq('id', entry_id).execute()
		except Exception as e:
			print(f'Failed to clean up privileged users: {str(e)}')


def test_user_can_see_only_their_privileges(setup_privileged_users):
	"""Test that regular users can only see their own privilege entries"""
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(user_token) as client:
		response = client.table('privileged_users').select('*').execute()

		# User should only see their own entries
		assert all(entry['user_id'] == setup_privileged_users['test_user_id'] for entry in response.data)
		assert len(response.data) == 1


def test_processor_can_see_all_privileges(setup_privileged_users):
	"""Test that processor can see all privilege entries"""
	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)

	with use_client(processor_token) as client:
		response = client.table('privileged_users').select('*').execute()

		# Processor should see all entries
		all_user_ids = {entry['user_id'] for entry in response.data}
		assert setup_privileged_users['test_user_id'] in all_user_ids
		assert setup_privileged_users['processor_id'] in all_user_ids
		assert len(all_user_ids) == 2


def test_non_privileged_user_sees_nothing(setup_privileged_users, test_user2):
	"""Test that a non-privileged user doesn't see any entries"""
	user2_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_client(user2_token) as client:
		response = client.table('privileged_users').select('*').execute()
		assert len(response.data) == 0


def test_new_columns_are_set_correctly(setup_privileged_users):
	"""Test that the new can_view_all_private and can_audit columns are set correctly"""
	user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(user_token) as client:
		response = client.table('privileged_users').select('*').execute()

		assert len(response.data) == 1
		entry = response.data[0]

		# Check that all new columns are present and set correctly
		assert entry['can_upload_private'] is True
		assert entry['can_view_all_private'] is True
		assert entry['can_audit'] is True


def test_limited_permissions_work_correctly(setup_privileged_users_with_limited_permissions):
	"""Test that users with limited permissions have the correct access"""
	# Test user with view_all_private permission
	view_user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(view_user_token) as client:
		response = client.table('privileged_users').select('*').execute()
		assert len(response.data) == 1
		entry = response.data[0]
		assert entry['can_view_all_private'] is True
		assert entry['can_audit'] is False
		assert entry['can_upload_private'] is False

	# Test user with audit permission
	audit_user_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_client(audit_user_token) as client:
		response = client.table('privileged_users').select('*').execute()
		assert len(response.data) == 1
		entry = response.data[0]
		assert entry['can_view_all_private'] is False
		assert entry['can_audit'] is True
		assert entry['can_upload_private'] is False


def test_can_view_all_private_function_works(
	setup_privileged_users_with_limited_permissions, datasets_with_mixed_access
):
	"""Test that the can_view_all_private_data() function works correctly with RLS"""
	# User with can_view_all_private should see private datasets
	view_user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(view_user_token) as client:
		# Should be able to see private dataset through the function
		response = (
			client.table(settings.datasets_table)
			.select('*')
			.eq('id', datasets_with_mixed_access['private_id'])
			.execute()
		)
		assert len(response.data) == 1

	# User without can_view_all_private should not see private datasets (unless they own them)
	audit_user_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_client(audit_user_token) as client:
		# Should not be able to see private dataset (assuming they don't own it)
		response = (
			client.table(settings.datasets_table)
			.select('*')
			.eq('id', datasets_with_mixed_access['private_id'])
			.execute()
		)
		assert len(response.data) == 0


def test_view_access_through_v2_full_dataset_view(
	setup_privileged_users_with_limited_permissions, datasets_with_mixed_access
):
	"""Test that the v2_full_dataset_view respects the can_view_all_private_data() function"""
	# User with can_view_all_private should see private datasets through the view
	view_user_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)

	with use_client(view_user_token) as client:
		response = (
			client.from_('v2_full_dataset_view')
			.select('*')
			.eq('id', datasets_with_mixed_access['private_id'])
			.execute()
		)
		assert len(response.data) == 1

	# User without can_view_all_private should not see private datasets through the view
	audit_user_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_client(audit_user_token) as client:
		response = (
			client.from_('v2_full_dataset_view')
			.select('*')
			.eq('id', datasets_with_mixed_access['private_id'])
			.execute()
		)
		assert len(response.data) == 0


def test_processor_still_has_access_to_everything(datasets_with_mixed_access):
	"""Test that the processor user still has access to all datasets (backward compatibility)"""
	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)

	with use_client(processor_token) as client:
		# Processor should still see private datasets
		response = (
			client.table(settings.datasets_table)
			.select('*')
			.eq('id', datasets_with_mixed_access['private_id'])
			.execute()
		)
		assert len(response.data) == 1

		# Processor should also see private datasets through the view
		response = (
			client.from_('v2_full_dataset_view')
			.select('*')
			.eq('id', datasets_with_mixed_access['private_id'])
			.execute()
		)
		assert len(response.data) == 1
