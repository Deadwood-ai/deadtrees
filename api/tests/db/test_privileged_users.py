import pytest
from shared.db import use_anon_client, use_client, use_service_client, login
from shared.settings import settings
import uuid
from shared.testing.fixtures import test_processor_user


@pytest.fixture(scope='function')
def setup_privileged_users(auth_token, test_user, test_user2, test_processor_user):
	"""Create test entries in the privileged_users table"""
	privileged_user_ids = []

	try:
		# Get processor token for all operations
		processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)

		# Create entries for both test user and processor
		with use_client(processor_token) as processor_client:
			# Normalize existing state for test users to keep assertions deterministic
			processor_client.table('privileged_users').delete().eq('user_id', test_user).execute()
			processor_client.table('privileged_users').delete().eq('user_id', test_user2).execute()

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
			# Normalize existing state for both test users
			processor_client.table('privileged_users').delete().eq('user_id', test_user).execute()
			processor_client.table('privileged_users').delete().eq('user_id', test_user2).execute()

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


def test_non_privileged_user_sees_nothing(setup_privileged_users, test_user2):
	"""Test that a non-privileged user doesn't see any entries"""
	user2_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_client(user2_token) as client:
		response = client.table('privileged_users').select('*').execute()
		assert len(response.data) == 0


def test_authenticated_user_cannot_promote_themselves(setup_privileged_users, test_user2):
	"""Authorization assignments can only be written by the processor/service role."""
	user_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	with use_client(user_token) as client:
		with pytest.raises(Exception, match='row-level security'):
			client.table('privileged_users').insert(
				{
					'user_id': test_user2,
					'can_upload_private': True,
					'can_view_all_private': True,
					'can_audit': True,
				}
			).execute()

	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)
	with use_client(processor_token) as client:
		response = client.table('privileged_users').select('id').eq('user_id', test_user2).execute()
		assert response.data == []


@pytest.mark.parametrize(
	'email_setting, password_setting',
	[('TEST_USER_EMAIL', 'TEST_USER_PASSWORD'), ('TEST_USER_EMAIL2', 'TEST_USER_PASSWORD2')],
)
def test_no_browser_client_can_write_search_query_log(setup_privileged_users, email_setting, password_setting):
	"""Only the API's service role writes the log - auditors included.

	Search is public, so the browser must have no write path here at all:
	otherwise the same grant would be reachable with the public anon key.
	"""
	user_token = login(getattr(settings, email_setting), getattr(settings, password_setting), use_cached_session=False)

	with use_client(user_token) as client:
		with pytest.raises(Exception, match='permission denied|row-level security'):
			client.table('v2_search_queries').insert({'query': 'bypass attempt'}).execute()


def test_service_role_logs_anonymous_search_and_auditors_can_read_it(setup_privileged_users):
	"""The API records public query text; reads stay restricted to auditors."""
	row_id = None
	try:
		with use_service_client() as client:
			response = client.table('v2_search_queries').insert(
				{'query': 'standing dead trees', 'user_id': None, 'is_anonymous': True}
			).execute()
			row_id = response.data[0]['id']

		auditor_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)
		with use_client(auditor_token) as client:
			response = client.table('v2_search_queries').select('*').eq('id', row_id).execute()
			assert len(response.data) == 1
			assert response.data[0]['query'] == 'standing dead trees'
			assert response.data[0]['user_id'] is None
			assert response.data[0]['is_anonymous'] is True
	finally:
		if row_id is not None:
			with use_service_client() as client:
				client.table('v2_search_queries').delete().eq('id', row_id).execute()


def test_search_rpcs_are_public(setup_privileged_users_with_limited_permissions):
	"""Anonymous visitors, non-auditors and auditors can all call both ranking RPCs."""
	embedding = '[' + ','.join(['1'] + ['0'] * 1023) + ']'
	non_auditor_token = login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD, use_cached_session=False)
	auditor_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2, use_cached_session=False)

	for token in (None, non_auditor_token, auditor_token):
		with use_client(token) if token else use_anon_client() as client:
			datasets = client.rpc(
				'search_datasets_by_embedding',
				{'query_embedding': embedding, 'match_count': 1},
			).execute()
			tiles = client.rpc(
				'search_tiles_by_embedding',
				{'query_embedding': embedding, 'p_dataset_id': 999999999, 'match_count': 1},
			).execute()

		assert isinstance(datasets.data, list)
		assert tiles.data == []


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
