import pytest
import shutil
from pathlib import Path
from shared.db import use_client, login
from shared.settings import settings
from supabase import create_client

from shared.testing.fixtures import (
	test_file,
	cleanup_database,
	data_directory,
)


@pytest.fixture(scope='session')
def test_user():
	"""Create a test user for all tests and clean up afterwards"""
	supabase = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
	user_id = None

	try:
		# Try to sign up the test user
		response = supabase.auth.sign_up(
			{
				'email': settings.TEST_USER_EMAIL,
				'password': settings.TEST_USER_PASSWORD,
			}
		)
		user_id = response.user.id if response.user else None
	except Exception:
		# If user exists, try to get the user ID
		try:
			response = supabase.auth.sign_in_with_password(
				{
					'email': settings.TEST_USER_EMAIL,
					'password': settings.TEST_USER_PASSWORD,
				}
			)
			user_id = response.user.id if response.user else None
		except Exception as e:
			pytest.fail(f'Could not create or retrieve test user: {str(e)}')

	yield user_id


@pytest.fixture(scope='session')
def test_user2():
	"""Create a test user for all tests and clean up afterwards"""
	supabase = create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)
	user_id = None

	try:
		# Try to sign up the test user
		response = supabase.auth.sign_up(
			{
				'email': settings.TEST_USER_EMAIL2,
				'password': settings.TEST_USER_PASSWORD2,
			}
		)
		user_id = response.user.id if response.user else None
	except Exception:
		# If user exists, try to get the user ID
		try:
			response = supabase.auth.sign_in_with_password(
				{
					'email': settings.TEST_USER_EMAIL2,
					'password': settings.TEST_USER_PASSWORD2,
				}
			)
			user_id = response.user.id if response.user else None
		except Exception as e:
			pytest.fail(f'Could not create or retrieve test user: {str(e)}')

	yield user_id


@pytest.fixture(scope='session')
def auth_token(test_user):
	"""Provide authentication token for tests"""
	return login(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD)
