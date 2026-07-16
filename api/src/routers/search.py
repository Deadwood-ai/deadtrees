"""Open-vocabulary search: encode a text query into a CLIP embedding.

The heavy lifting (ranking datasets/tiles) happens in Postgres via the
``search_datasets_by_embedding`` / ``search_tiles_by_embedding`` RPCs, which the
frontend calls directly through supabase-js. The ranking RPCs temporarily
require auditor access and retain the caller's auth context for dataset
visibility. This endpoint only turns free text into the OpenCLIP text embedding
that those RPCs expect.
"""

import logging
from collections import defaultdict, deque
from functools import lru_cache
from ipaddress import ip_address, ip_network
from threading import Lock
from time import monotonic
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

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


@router.post('/embed', response_model=EmbedResponse)
def embed_query(payload: EmbedRequest, request: Request) -> EmbedResponse:
	"""Encode a text query into a pgvector literal for similarity ranking."""
	_check_search_embed_rate_limit(_search_client_key(request))
	query = _normalize_query(payload.query)
	literal = _embed_query(query)
	return EmbedResponse(embedding=literal, dim=EMBEDDING_DIM)
