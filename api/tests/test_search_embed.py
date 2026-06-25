"""Unit tests for the open-vocabulary ``/search/embed`` endpoint.

The endpoint's only job is to validate the query and turn the CLIP text
embedding into a pgvector literal that the ranking RPCs consume. The model call
is stubbed so these stay fast and need no weights / GPU.
"""

import pytest
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.src.routers import search as search_module
from api.src.routers.search import (
	EmbedRequest,
	MAX_QUERY_LENGTH,
	_check_search_embed_rate_limit,
	_trusted_proxy_networks,
	_search_client_key,
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

	resp = embed_query(EmbedRequest(query='standing dead trees'), request=_request())

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

	embed_query(EmbedRequest(query='  oak forest \n'), request=_request())

	assert captured['query'] == 'oak forest'


@pytest.mark.parametrize('query', ['', '   ', '\n\t'])
def test_blank_query_is_rejected(query):
	with pytest.raises(HTTPException) as exc:
		embed_query(EmbedRequest(query=query), request=_request())
	assert exc.value.status_code == 400


def test_overlong_query_is_rejected():
	with pytest.raises(HTTPException) as exc:
		embed_query(EmbedRequest(query='x' * (MAX_QUERY_LENGTH + 1)), request=_request())
	assert exc.value.status_code == 400


def test_query_at_max_length_is_allowed(monkeypatch):
	_stub_embedding(monkeypatch, [0.0])
	resp = embed_query(EmbedRequest(query='x' * MAX_QUERY_LENGTH), request=_request())
	assert resp.dim == EMBEDDING_DIM


def test_model_failure_returns_503(monkeypatch):
	def _boom(_query):
		raise RuntimeError('model unavailable')

	monkeypatch.setattr(search_module, 'embed_text', _boom)

	with pytest.raises(HTTPException) as exc:
		embed_query(EmbedRequest(query='oak'), request=_request())
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
	embed_query(EmbedRequest(query='oak'), request=request)
	embed_query(EmbedRequest(query='beech'), request=request)

	with pytest.raises(HTTPException) as exc:
		embed_query(EmbedRequest(query='pine'), request=request)

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
