import pytest

import shared.db as db


def test_login_verified_falls_back_to_uncached_login(monkeypatch):
	attempts = []

	def fake_login(user, password, use_cached_session=True):
		attempts.append(use_cached_session)
		return 'cached-token' if use_cached_session else 'fresh-token'

	def fake_verify(token):
		if token == 'cached-token':
			return False
		return {'id': 'processor-user'}

	monkeypatch.setattr(db, 'login', fake_login)
	monkeypatch.setattr(db, 'verify_token', fake_verify)

	token, user = db.login_verified('processor@deadtrees.earth', 'secret')

	assert attempts == [True, False]
	assert token == 'fresh-token'
	assert user == {'id': 'processor-user'}


def test_login_verified_returns_first_valid_token(monkeypatch):
	attempts = []

	def fake_login(user, password, use_cached_session=True):
		attempts.append(use_cached_session)
		return 'cached-token'

	def fake_verify(token):
		return {'id': 'processor-user'}

	monkeypatch.setattr(db, 'login', fake_login)
	monkeypatch.setattr(db, 'verify_token', fake_verify)

	token, user = db.login_verified('processor@deadtrees.earth', 'secret')

	assert attempts == [True]
	assert token == 'cached-token'
	assert user == {'id': 'processor-user'}


def test_use_service_client_requires_service_role_key(monkeypatch):
	monkeypatch.setattr(db.settings, 'SUPABASE_SERVICE_ROLE_KEY', '')

	with pytest.raises(ValueError, match='SUPABASE_SERVICE_ROLE_KEY is required'):
		with db.use_service_client():
			pass


class _FakeAuth:
	"""Stands in for Supabase Auth: one password per account, a new token per sign-in."""

	accounts = {'a@example.com': 'secret-a', 'b@example.com': 'secret-b'}
	sign_ins = []

	def sign_in_with_password(self, credentials):
		email, password = credentials['email'], credentials['password']
		self.sign_ins.append(email)
		if self.accounts.get(email) != password:
			raise RuntimeError('Invalid login credentials')
		session = type('Session', (), {'access_token': f'token-{email}-{len(self.sign_ins)}', 'expires_at': 2**40})
		return type('AuthResponse', (), {'session': session})


@pytest.fixture
def fake_auth(monkeypatch):
	_FakeAuth.sign_ins = []
	monkeypatch.setattr(db, '_cached_sessions', {})
	monkeypatch.setattr(db, 'create_client', lambda *args, **kwargs: type('Client', (), {'auth': _FakeAuth()}))
	return _FakeAuth


def test_cached_login_never_returns_another_account_or_skips_the_password(fake_auth):
	token_a = db.login('a@example.com', 'secret-a')

	assert db.login('a@example.com', 'secret-a') == token_a
	with pytest.raises(Exception, match='Login failed'):
		db.login('a@example.com', 'wrong')
	with pytest.raises(Exception, match='Login failed'):
		db.login('b@example.com', 'wrong')
	token_b = db.login('b@example.com', 'secret-b')

	assert token_b.startswith('token-b@example.com')
	assert fake_auth.sign_ins == ['a@example.com', 'a@example.com', 'b@example.com', 'b@example.com']


def test_uncached_login_always_signs_in(fake_auth):
	db.login('a@example.com', 'secret-a', use_cached_session=False)
	db.login('a@example.com', 'secret-a', use_cached_session=False)

	assert fake_auth.sign_ins == ['a@example.com', 'a@example.com']
	assert db._cached_sessions == {}


def test_rejected_token_returns_false_and_leaves_the_cache(fake_auth, monkeypatch):
	token = db.login('a@example.com', 'secret-a')

	class _RejectingClient:
		class auth:
			@staticmethod
			def get_user(jwt):
				raise RuntimeError('Session from session_id claim in JWT does not exist')

		def __enter__(self):
			return self

		def __exit__(self, *args):
			return False

	monkeypatch.setattr(db, 'use_client', lambda jwt: _RejectingClient())

	assert db.verify_token(token) is False
	assert db._cached_sessions == {}
	assert db.login('a@example.com', 'secret-a') != token
