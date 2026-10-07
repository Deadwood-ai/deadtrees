"""Sign-up goes through the API captcha and answers the same for new and known emails."""

import uuid

import pytest
from fastapi.testclient import TestClient

from api.src.access import signup as signup_module
from api.src.notifications.mailpit import assert_email_received, get_message_by_id, get_messages, purge_messages
from api.src.routers import auth as auth_router
from api.src.server import app
from shared.db import use_service_client
from shared.settings import settings

client = TestClient(app)
PASSWORD = 'signup-test-password-1'


@pytest.fixture
def new_email():
	email = f'signup-{uuid.uuid4().hex[:10]}@example.com'
	purge_messages()
	auth_router._signup_limiter.clear()
	yield email
	_delete_accounts(lambda address: address == email or address.endswith(f'-{email}'))


@pytest.fixture
def captcha(monkeypatch):
	result = {'passes': True, 'tokens': []}

	def fake_captcha(token, client_ip):
		result['tokens'].append(token)
		return result['passes']

	monkeypatch.setattr(auth_router, 'captcha_passes', fake_captcha)
	return result


def _signup(email: str, captcha_token: str = 'token'):
	return client.post(
		'/api/v1/auth/signup',
		json={'email': email, 'password': PASSWORD, 'captcha_token': captcha_token, 'redirect_to': 'http://localhost/'},
	)


def _delete_accounts(matches) -> None:
	with use_service_client() as db:
		for user in db.auth.admin.list_users(per_page=1000):
			if user.email and matches(user.email):
				db.auth.admin.delete_user(user.id)


def _account(email: str):
	with use_service_client() as db:
		return next((user for user in db.auth.admin.list_users(per_page=1000) if user.email == email), None)


def test_signup_creates_an_unconfirmed_account_and_emails_the_link(new_email, captcha):
	response = _signup(new_email)
	assert response.status_code == 200, response.text
	assert captcha['tokens'] == ['token']

	account = _account(new_email)
	assert account is not None and account.email_confirmed_at is None
	message = assert_email_received('Confirm your DeadTrees account', new_email)
	body = get_message_by_id(message['ID'])
	assert '/auth/v1/verify' in body['Text'] and 'type=signup' in body['Text']


def test_known_email_gets_the_same_answer_without_an_email(new_email, captcha):
	first = _signup(new_email)
	with use_service_client() as db:
		db.auth.admin.update_user_by_id(_account(new_email).id, {'email_confirm': True})
	purge_messages()
	second = _signup(new_email)
	assert second.status_code == first.status_code == 200
	assert second.json() == first.json()
	assert get_messages() == []


def test_failed_captcha_creates_nothing(new_email, captcha):
	captcha['passes'] = False
	assert _signup(new_email).status_code == 400
	assert _account(new_email) is None


def test_signups_are_limited_per_network(new_email, captcha):
	for _ in range(auth_router.SIGNUPS_PER_IP_PER_HOUR):
		assert _signup(f'limit-{uuid.uuid4().hex[:8]}-{new_email}').status_code in (200, 400)
	assert _signup(new_email).status_code == 429


def test_captcha_secret_is_required_outside_development(monkeypatch):
	monkeypatch.setattr(settings, 'TURNSTILE_SECRET_KEY', '')
	monkeypatch.setattr(settings, 'DEV_MODE', False)
	with pytest.raises(RuntimeError):
		signup_module.captcha_passes('token', None)
