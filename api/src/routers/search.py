"""Open-vocabulary search: encode a text query into a CLIP embedding.

The heavy lifting (ranking datasets/tiles) happens in Postgres via the
``search_datasets_by_embedding`` / ``search_tiles_by_embedding`` RPCs, which the
frontend calls directly through supabase-js. The ranking RPCs are public
(anonymous callers included) and retain the caller's auth context for dataset
visibility. This endpoint turns free text into the OpenCLIP text embedding that
those RPCs expect, and records the query for analytics.

It is also the only writer of ``v2_search_queries``: the browser has no grant on
that table, so public query text can be logged without handing the public anon
key an unbounded write path (see 20260923120000_log-public-search-queries.sql).
"""

import logging
from collections import defaultdict, deque
from functools import lru_cache
from ipaddress import ip_address, ip_network
from threading import Lock
from time import monotonic
from typing import Annotated
from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Request
from pydantic import BaseModel, Field

from shared.db import use_service_client, verify_token
from shared.settings import settings
from shared.embedding_model import EMBEDDING_DIM, embed_text

logger = logging.getLogger(__name__)

router = APIRouter(prefix='/search', tags=['search'])

MAX_QUERY_LENGTH = 300
SEARCH_EMBED_RATE_LIMIT = 30
SEARCH_EMBED_RATE_WINDOW_SECONDS = 60

_search_embed_requests: dict[str, deque[float]] = defaultdict(deque)
_search_embed_rate_lock = Lock()


class EmbedRequest(BaseModel):
	query: str = Field(..., description='Free-text open-vocabulary search query')
	# Set by the per-orthophoto tile search; absent for the global archive search.
	dataset_id: int | None = Field(default=None, ge=1, description='Dataset the search is scoped to')


class EmbedResponse(BaseModel):
	# pgvector text literal '[v1,v2,...]' ready to pass to the ranking RPCs.
	embedding: str = Field(..., description="CLIP text embedding as a pgvector literal")
	dim: int = Field(..., description='Embedding dimensionality')


@lru_cache(maxsize=16)
def _trusted_proxy_networks(config: str) -> tuple:
	networks = []
	for raw_entry in config.split(','):
		entry = raw_entry.strip()
		if not entry:
			continue
		try:
			networks.append(ip_network(entry, strict=False))
		except ValueError:
			logger.warning('Ignoring invalid trusted proxy entry for search rate limit')
	return tuple(networks)


def _is_trusted_proxy(host: str | None) -> bool:
	if not host:
		return False
	try:
		address = ip_address(host)
	except ValueError:
		return False
	return any(address in network for network in _trusted_proxy_networks(settings.SEARCH_RATE_LIMIT_TRUSTED_PROXIES))


def _parse_ip(host: str) -> bool:
	try:
		ip_address(host)
	except ValueError:
		return False
	return True


def _search_client_key(request: Request) -> str:
	"""Client key for the public embedding rate limit.

	Only trust ``X-Real-IP`` from configured proxy peers. Host nginx overwrites
	that header with ``$remote_addr``; ``X-Forwarded-For`` is appendable and can
	preserve client-supplied spoofed hops, so it is not used for limiter keys.
	"""
	client_host = request.client.host if request.client else None
	if _is_trusted_proxy(client_host):
		real_ip = request.headers.get('x-real-ip', '').strip()
		if real_ip and _parse_ip(real_ip):
			return real_ip

	if client_host:
		return client_host

	return 'unknown'


def _check_search_embed_rate_limit(client_key: str, now: float | None = None) -> None:
	"""Small in-process sliding-window limiter for the public CLIP endpoint."""
	now = monotonic() if now is None else now
	window_start = now - SEARCH_EMBED_RATE_WINDOW_SECONDS

	with _search_embed_rate_lock:
		requests = _search_embed_requests[client_key]
		while requests and requests[0] <= window_start:
			requests.popleft()

		if len(requests) >= SEARCH_EMBED_RATE_LIMIT:
			retry_after = max(1, int(SEARCH_EMBED_RATE_WINDOW_SECONDS - (now - requests[0])))
			raise HTTPException(
				status_code=429,
				detail='Search rate limit exceeded. Please try again shortly.',
				headers={'Retry-After': str(retry_after)},
			)

		requests.append(now)


def _normalize_query(query: str) -> str:
	query = query.strip()
	if not query:
		raise HTTPException(status_code=400, detail='Query must not be empty')
	if len(query) > MAX_QUERY_LENGTH:
		raise HTTPException(status_code=400, detail=f'Query exceeds {MAX_QUERY_LENGTH} characters')
	return query


def _embed_query(query: str) -> str:
	try:
		vector = embed_text(query)
	except Exception as e:  # model load / inference failure
		logger.error(f'Failed to embed query: {e}', exc_info=True)
		raise HTTPException(status_code=503, detail='Search model unavailable')

	return '[' + ','.join(f'{v:.6f}' for v in vector) + ']'


def _verified_user_id(authorization: str | None) -> str | None:
	"""Resolve the caller's user id from an optional bearer token.

	The endpoint stays public: a missing, malformed or rejected token just means
	the query is recorded as anonymous rather than refused.
	"""
	if not authorization:
		return None

	scheme, _, raw_token = authorization.partition(' ')
	token = raw_token.strip()
	if scheme.lower() != 'bearer' or not token:
		return None

	user = verify_token(token)
	return user.id if user else None


def _log_search_query(query: str, dataset_id: int | None, authorization: str | None) -> None:
	"""Record one served query for analytics, after the response has been sent.

	Writes with the service role, which is what keeps the table unreachable from
	the browser. Nothing identifying the caller is stored beyond the user id we
	could verify - no IP, no session, no user agent - so anonymous rows cannot be
	traced back to a visitor. Analytics must never break search, so every failure
	is swallowed, and the query text is never echoed into the logs.
	"""
	if not settings.SUPABASE_SERVICE_ROLE_KEY:
		logger.debug('Skipping search query logging: no service role key configured')
		return

	try:
		user_id = _verified_user_id(authorization)
		with use_service_client() as client:
			client.table('v2_search_queries').insert(
				{
					'query': query,
					'dataset_id': dataset_id,
					'user_id': user_id,
					'is_anonymous': user_id is None,
				}
			).execute()
	except Exception as e:
		# Only the failure shape, never the exception text: Postgres quotes the
		# offending row (and therefore the query) in constraint violations.
		error_code = getattr(e, 'code', 'n/a')
		logger.warning(f'Failed to log search query: {type(e).__name__} (code {error_code})')


@router.post('/embed', response_model=EmbedResponse)
def embed_query(
	payload: EmbedRequest,
	request: Request,
	background_tasks: BackgroundTasks,
	authorization: Annotated[str | None, Header()] = None,
) -> EmbedResponse:
	"""Encode a text query into a pgvector literal for similarity ranking."""
	_check_search_embed_rate_limit(_search_client_key(request))
	query = _normalize_query(payload.query)
	literal = _embed_query(query)
	# Only queries we actually served are logged, and never on the response path:
	# logging can neither slow a search down nor turn a good one into an error.
	background_tasks.add_task(_log_search_query, query, payload.dataset_id, authorization)
	return EmbedResponse(embedding=literal, dim=EMBEDDING_DIM)
