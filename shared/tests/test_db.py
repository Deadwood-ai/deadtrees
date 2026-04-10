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
