"""Unit tests for the open-vocabulary ``/search/embed`` endpoint.

The endpoint's only job is to validate the query and turn the CLIP text
embedding into a pgvector literal that the ranking RPCs consume. The model call
is stubbed so these stay fast and need no weights / GPU.
"""

import pytest
from fastapi import HTTPException

from api.src.routers import search as search_module
from api.src.routers.search import EmbedRequest, MAX_QUERY_LENGTH, embed_query
from shared.embedding_model import EMBEDDING_DIM

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def _guard_model(monkeypatch):
	"""Fail loudly (instead of loading the real CLIP model) if a code path embeds
	a query it should have rejected first."""

	def _should_not_be_called(_query):
		raise AssertionError('embed_text was called for an input that should be rejected')

	monkeypatch.setattr(search_module, 'embed_text', _should_not_be_called)


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

	resp = embed_query(EmbedRequest(query='standing dead trees'))

	# Bracketed, fixed 6-decimal literal that Postgres casts via ::vector.
	assert resp.embedding == '[0.100000,-0.200000,0.333333]'
	assert resp.dim == EMBEDDING_DIM


def test_query_is_stripped_before_embedding(monkeypatch):
	captured = _stub_embedding(monkeypatch, [0.0])

	embed_query(EmbedRequest(query='  oak forest \n'))

	assert captured['query'] == 'oak forest'


@pytest.mark.parametrize('query', ['', '   ', '\n\t'])
def test_blank_query_is_rejected(query):
	with pytest.raises(HTTPException) as exc:
		embed_query(EmbedRequest(query=query))
	assert exc.value.status_code == 400


def test_overlong_query_is_rejected():
	with pytest.raises(HTTPException) as exc:
		embed_query(EmbedRequest(query='x' * (MAX_QUERY_LENGTH + 1)))
	assert exc.value.status_code == 400


def test_query_at_max_length_is_allowed(monkeypatch):
	_stub_embedding(monkeypatch, [0.0])
	resp = embed_query(EmbedRequest(query='x' * MAX_QUERY_LENGTH))
	assert resp.dim == EMBEDDING_DIM


def test_model_failure_returns_503(monkeypatch):
	def _boom(_query):
		raise RuntimeError('model unavailable')

	monkeypatch.setattr(search_module, 'embed_text', _boom)

	with pytest.raises(HTTPException) as exc:
		embed_query(EmbedRequest(query='oak'))
	assert exc.value.status_code == 503
