"""Unit tests for the open-vocabulary ``/search/embed`` endpoint.

The endpoint validates the query, turns the CLIP text embedding into a pgvector
literal that the ranking RPCs consume, and records the served query for
analytics. The model call and the database are stubbed so these stay fast and
need no weights / GPU / Supabase.
"""

from contextlib import contextmanager

import pytest
from types import SimpleNamespace

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.src.routers import search as search_module
from api.src.routers.search import (
	EmbedRequest,
	MAX_QUERY_LENGTH,
	_check_search_embed_rate_limit,
	_log_search_query,
	_trusted_proxy_networks,
	_search_client_key,
	_verified_user_id,
	embed_query,
)
from shared.embedding_model import EMBEDDING_DIM

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def _guard_model(monkeypatch):
	"""Fail loudly (instead of loading the real CLIP model) if a code path embeds
	a query it should have rejected first."""

	def _should_not_be_called(_query):
		raise AssertionError('embed_text was called for an input that should be rejected')

	monkeypatch.setattr(search_module, 'embed_text', _should_not_be_called)


@pytest.fixture(autouse=True)
def _reset_rate_limit():
	trusted_proxies = search_module.settings.SEARCH_RATE_LIMIT_TRUSTED_PROXIES
	search_module._search_embed_requests.clear()
	_trusted_proxy_networks.cache_clear()
	yield
	search_module.settings.SEARCH_RATE_LIMIT_TRUSTED_PROXIES = trusted_proxies
	search_module._search_embed_requests.clear()
	_trusted_proxy_networks.cache_clear()


@pytest.fixture(autouse=True)
def _no_database(monkeypatch):
	"""Keep query logging inert unless a test opts in, so no unit test writes rows."""
	monkeypatch.setattr(search_module.settings, 'SUPABASE_SERVICE_ROLE_KEY', '')


class _FakeTable:
	def __init__(self, sink, name):
		self._sink = sink
		self._name = name

	def insert(self, payload):
		self._sink.append((self._name, payload))
		return self

	def execute(self):
		return SimpleNamespace(data=[])


def _stub_service_client(monkeypatch, sink, fail=False):
	"""Capture what the logger would have written, without touching Supabase."""
	monkeypatch.setattr(search_module.settings, 'SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')

	@contextmanager
	def _fake_client():
		if fail:
			raise RuntimeError('supabase unreachable')
		yield SimpleNamespace(table=lambda name: _FakeTable(sink, name))

	monkeypatch.setattr(search_module, 'use_service_client', _fake_client)
	return sink


def _request(host='127.0.0.1', headers=None):
	return SimpleNamespace(headers=headers or {}, client=SimpleNamespace(host=host))


def _stub_embedding(monkeypatch, vector):
	"""Make embed_text return ``vector`` and capture the text it was given."""
	captured = {}

	def _stub(query):
		captured['query'] = query
		return vector

	monkeypatch.setattr(search_module, 'embed_text', _stub)
	return captured


def test_returns_six_decimal_pgvector_literal(monkeypatch):
	_stub_embedding(monkeypatch, [0.1, -0.2, 0.333333])

	resp = embed_query(EmbedRequest(query='standing dead trees'), request=_request(), background_tasks=BackgroundTasks())

	# Bracketed, fixed 6-decimal literal that Postgres casts via ::vector.
	assert resp.embedding == '[0.100000,-0.200000,0.333333]'
	assert resp.dim == EMBEDDING_DIM


def test_embed_route_is_public(monkeypatch):
	_stub_embedding(monkeypatch, [0.1])
	app = FastAPI()
	app.include_router(search_module.router)

	response = TestClient(app).post('/search/embed', json={'query': 'standing dead trees'})

	assert response.status_code == 200
	assert response.json() == {'embedding': '[0.100000]', 'dim': EMBEDDING_DIM}


def test_query_is_stripped_before_embedding(monkeypatch):
	captured = _stub_embedding(monkeypatch, [0.0])

	embed_query(EmbedRequest(query='  oak forest \n'), request=_request(), background_tasks=BackgroundTasks())

	assert captured['query'] == 'oak forest'


@pytest.mark.parametrize('query', ['', '   ', '\n\t'])
def test_blank_query_is_rejected(query):
	with pytest.raises(HTTPException) as exc:
		embed_query(EmbedRequest(query=query), request=_request(), background_tasks=BackgroundTasks())
	assert exc.value.status_code == 400


def test_overlong_query_is_rejected():
	with pytest.raises(HTTPException) as exc:
		embed_query(EmbedRequest(query='x' * (MAX_QUERY_LENGTH + 1)), request=_request(), background_tasks=BackgroundTasks())
	assert exc.value.status_code == 400


def test_query_at_max_length_is_allowed(monkeypatch):
	_stub_embedding(monkeypatch, [0.0])
	resp = embed_query(EmbedRequest(query='x' * MAX_QUERY_LENGTH), request=_request(), background_tasks=BackgroundTasks())
	assert resp.dim == EMBEDDING_DIM


def test_model_failure_returns_503(monkeypatch):
	def _boom(_query):
		raise RuntimeError('model unavailable')

	monkeypatch.setattr(search_module, 'embed_text', _boom)

	with pytest.raises(HTTPException) as exc:
		embed_query(EmbedRequest(query='oak'), request=_request(), background_tasks=BackgroundTasks())
	assert exc.value.status_code == 503


def test_client_key_ignores_spoofable_forwarded_headers():
	request = _request(host='10.0.0.2', headers={'x-real-ip': '198.51.100.10'})
	search_module.settings.SEARCH_RATE_LIMIT_TRUSTED_PROXIES = '127.0.0.1,::1'

	assert _search_client_key(request) == '10.0.0.2'


def test_client_key_ignores_spoofable_x_forwarded_for_header():
	request = _request(host='10.0.0.2', headers={'x-forwarded-for': '198.51.100.10, 10.0.0.2'})
	search_module.settings.SEARCH_RATE_LIMIT_TRUSTED_PROXIES = '127.0.0.1,::1'

	assert _search_client_key(request) == '10.0.0.2'


def test_client_key_trusts_real_ip_from_configured_proxy():
	request = _request(host='172.18.0.1', headers={'x-real-ip': '198.51.100.10'})
	search_module.settings.SEARCH_RATE_LIMIT_TRUSTED_PROXIES = '172.16.0.0/12'
	_trusted_proxy_networks.cache_clear()

	assert _search_client_key(request) == '198.51.100.10'


def test_client_key_ignores_forwarded_for_even_from_configured_proxy():
	request = _request(host='172.18.0.1', headers={'x-forwarded-for': '198.51.100.10, 172.18.0.1'})
	search_module.settings.SEARCH_RATE_LIMIT_TRUSTED_PROXIES = '172.16.0.0/12'
	_trusted_proxy_networks.cache_clear()

	assert _search_client_key(request) == '172.18.0.1'


def test_client_key_ignores_invalid_real_ip_from_configured_proxy():
	request = _request(host='172.18.0.1', headers={'x-real-ip': 'not an ip'})
	search_module.settings.SEARCH_RATE_LIMIT_TRUSTED_PROXIES = '172.16.0.0/12'
	_trusted_proxy_networks.cache_clear()

	assert _search_client_key(request) == '172.18.0.1'


def test_search_rate_limit_blocks_same_client_before_model(monkeypatch):
	calls = 0

	def _stub(_query):
		nonlocal calls
		calls += 1
		return [0.0]

	monkeypatch.setattr(search_module, 'SEARCH_EMBED_RATE_LIMIT', 2)
	monkeypatch.setattr(search_module, 'SEARCH_EMBED_RATE_WINDOW_SECONDS', 60)
	monkeypatch.setattr(search_module, 'embed_text', _stub)

	request = _request(host='203.0.113.5')
	embed_query(EmbedRequest(query='oak'), request=request, background_tasks=BackgroundTasks())
	embed_query(EmbedRequest(query='beech'), request=request, background_tasks=BackgroundTasks())

	with pytest.raises(HTTPException) as exc:
		embed_query(EmbedRequest(query='pine'), request=request, background_tasks=BackgroundTasks())

	assert exc.value.status_code == 429
	assert 1 <= int(exc.value.headers['Retry-After']) <= 60
	assert calls == 2


def test_search_rate_limit_sliding_window_expires_old_entries(monkeypatch):
	monkeypatch.setattr(search_module, 'SEARCH_EMBED_RATE_LIMIT', 2)
	monkeypatch.setattr(search_module, 'SEARCH_EMBED_RATE_WINDOW_SECONDS', 60)

	_check_search_embed_rate_limit('198.51.100.10', now=0)
	_check_search_embed_rate_limit('198.51.100.10', now=1)
	with pytest.raises(HTTPException) as exc:
		_check_search_embed_rate_limit('198.51.100.10', now=2)
	assert exc.value.status_code == 429

	_check_search_embed_rate_limit('198.51.100.10', now=61)


def test_served_query_is_scheduled_for_logging_off_the_response_path(monkeypatch):
	_stub_embedding(monkeypatch, [0.0])
	background_tasks = BackgroundTasks()

	embed_query(
		EmbedRequest(query='  standing dead trees ', dataset_id=42),
		request=_request(),
		background_tasks=background_tasks,
		authorization='Bearer token-abc',
	)

	assert len(background_tasks.tasks) == 1
	task = background_tasks.tasks[0]
	assert task.func is _log_search_query
	# The normalized text is logged, together with the dataset the search was
	# scoped to and the token the attribution is resolved from.
	assert task.args == ('standing dead trees', 42, 'Bearer token-abc')


def test_archive_search_is_logged_without_a_dataset(monkeypatch):
	_stub_embedding(monkeypatch, [0.0])
	background_tasks = BackgroundTasks()

	embed_query(EmbedRequest(query='clearcut'), request=_request(), background_tasks=background_tasks)

	assert background_tasks.tasks[0].args == ('clearcut', None, None)


@pytest.mark.parametrize('query', ['', 'x' * (MAX_QUERY_LENGTH + 1)])
def test_rejected_query_is_never_logged(query):
	background_tasks = BackgroundTasks()

	with pytest.raises(HTTPException):
		embed_query(EmbedRequest(query=query), request=_request(), background_tasks=background_tasks)

	assert background_tasks.tasks == []


def test_rate_limited_query_is_never_logged(monkeypatch):
	_stub_embedding(monkeypatch, [0.0])
	monkeypatch.setattr(search_module, 'SEARCH_EMBED_RATE_LIMIT', 1)
	request = _request(host='203.0.113.9')
	embed_query(EmbedRequest(query='oak'), request=request, background_tasks=BackgroundTasks())

	background_tasks = BackgroundTasks()
	with pytest.raises(HTTPException) as exc:
		embed_query(EmbedRequest(query='beech'), request=request, background_tasks=background_tasks)

	assert exc.value.status_code == 429
	assert background_tasks.tasks == []


def test_anonymous_query_is_logged_without_a_user(monkeypatch):
	writes = _stub_service_client(monkeypatch, [])

	_log_search_query('standing dead trees', None, None)

	assert writes == [
		(
			'v2_search_queries',
			{
				'query': 'standing dead trees',
				'dataset_id': None,
				'user_id': None,
				'is_anonymous': True,
			},
		)
	]


def test_signed_in_query_is_attributed_to_the_verified_user(monkeypatch):
	writes = _stub_service_client(monkeypatch, [])
	monkeypatch.setattr(search_module, 'verify_token', lambda token: SimpleNamespace(id='user-1'))

	_log_search_query('beech', 7, 'Bearer valid-token')

	assert writes[0][1] == {
		'query': 'beech',
		'dataset_id': 7,
		'user_id': 'user-1',
		'is_anonymous': False,
	}


def test_rejected_token_is_logged_as_anonymous(monkeypatch):
	writes = _stub_service_client(monkeypatch, [])
	monkeypatch.setattr(search_module, 'verify_token', lambda token: False)

	_log_search_query('oak', None, 'Bearer expired-token')

	assert writes[0][1]['user_id'] is None
	assert writes[0][1]['is_anonymous'] is True


def test_logging_is_skipped_without_a_service_role_key(monkeypatch):
	def _should_not_be_called():
		raise AssertionError('the log must not be written without the service role')

	monkeypatch.setattr(search_module, 'use_service_client', _should_not_be_called)

	_log_search_query('oak', None, None)


def test_logging_failure_never_propagates(monkeypatch):
	_stub_service_client(monkeypatch, [], fail=True)

	# A failed insert must not surface to the caller: the search itself succeeded.
	_log_search_query('oak', None, None)


@pytest.mark.parametrize('header', [None, '', 'token-without-scheme', 'Basic user:pass', 'Bearer', 'Bearer    '])
def test_unusable_authorization_headers_resolve_to_anonymous(monkeypatch, header):
	def _should_not_be_called(_token):
		raise AssertionError('a malformed header must not reach token verification')

	monkeypatch.setattr(search_module, 'verify_token', _should_not_be_called)

	assert _verified_user_id(header) is None
