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
			# Add test user to privileged users
			test_user_entry = {'user_id': test_user, 'can_upload_private': True}
			response = processor_client.table('privileged_users').insert(test_user_entry).execute()
			if response.data:
				privileged_user_ids.append(response.data[0]['id'])

			# Add processor to privileged users if it's a different user
			if test_processor_user and test_processor_user != test_user:
				processor_entry = {'user_id': test_processor_user, 'can_upload_private': True}
				response = processor_client.table('privileged_users').insert(processor_entry).execute()
				if response.data:
					privileged_user_ids.append(response.data[0]['id'])

		yield {
			'test_user_id': test_user,
			'processor_id': test_processor_user,
			'entry_ids': privileged_user_ids,
		}

	finally:
		# Clean up entries using processor token
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

		# If test_user and processor are different, should see both
		# if setup_privileged_users['test_user_id'] != setup_privileged_users['processor_id']:
		assert setup_privileged_users['processor_id'] in all_user_ids
		assert len(all_user_ids) == 2


def test_non_privileged_user_sees_nothing(setup_privileged_users, test_user2):
	"""Test that a non-privileged user doesn't see any entries"""
	# Use test_user2 as the non-privileged user
	user2_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	# Verify non-privileged user sees nothing
	with use_client(user2_token) as client:
		response = client.table('privileged_users').select('*').execute()
		assert len(response.data) == 0


# def test_cascade_deletion_simulation(setup_privileged_users, test_user2):
# 	"""Test a simulation of cascading deletion by direct DB manipulation"""
# 	# Add test_user2 to privileged users with processor token
# 	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)

# 	with use_client(processor_token) as client:
# 		# First verify test_user2 entry doesn't exist
# 		response = client.table('privileged_users').select('*').eq('user_id', test_user2).execute()
# 		initial_count = len(response.data)

# 		# Add test_user2 to privileged_users
# 		entry = {'user_id': test_user2, 'can_upload_private': True}
# 		response = client.table('privileged_users').insert(entry).execute()
# 		entry_id = response.data[0]['id'] if response.data else None

# 		# Verify entry was created
# 		assert entry_id is not None

# 		# Verify entry exists
# 		response = client.table('privileged_users').select('*').eq('user_id', test_user2).execute()
# 		assert len(response.data) == initial_count + 1

# 		# Clean up - delete just the entry we created
# 		try:
# 			client.table('privileged_users').delete().eq('id', entry_id).execute()
# 		except Exception:
# 			print(f'Failed to clean up test_user2 privileged entry {entry_id}')
