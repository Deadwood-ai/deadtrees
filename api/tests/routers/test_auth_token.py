"""/token must sign in with the submitted credentials on every request."""
from fastapi.testclient import TestClient

from api.src.server import app
from shared.db import verify_token
from shared.settings import settings

client = TestClient(app)


def request_token(email, password):
	return client.post('/token', data={'username': email, 'password': password})


def test_token_belongs_to_the_submitted_account_and_needs_its_password(test_user, test_user2):
	first = request_token(settings.TEST_USER_EMAIL, settings.TEST_USER_PASSWORD)
	assert first.status_code == 200

	# A cached session of the first account must never leak to anyone else.
	assert request_token(settings.TEST_USER_EMAIL, 'wrong-password').status_code == 401
	assert request_token(settings.TEST_USER_EMAIL2, 'wrong-password').status_code == 401

	second = request_token(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2)
	assert second.status_code == 200
	assert verify_token(second.json()['access_token']).id == test_user2
	assert verify_token(first.json()['access_token']).id == test_user


def test_rejected_bearer_token_is_a_401_not_a_server_error():
	response = client.put(
		'/datasets/1/process',
		headers={'Authorization': 'Bearer not-a-valid-token'},
		json={'task_types': ['cog']},
	)
	assert response.status_code == 401
