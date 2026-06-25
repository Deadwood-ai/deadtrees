"""Open-vocabulary search: encode a text query into a CLIP embedding.

The heavy lifting (ranking datasets/tiles) happens in Postgres via the
``search_datasets_by_embedding`` / ``search_tiles_by_embedding`` RPCs, which the
frontend calls directly through supabase-js so row-level security enforces
per-user dataset visibility. This endpoint's only job is to turn a free-text
query into the matching OpenCLIP ViT-H/14 text embedding (as a pgvector literal)
that those RPCs expect.

The model is loaded lazily on the first request and cached for the process
lifetime (see ``shared.embedding_model.get_text_bundle``).
"""

import logging
from collections import defaultdict, deque
from threading import Lock
from time import monotonic

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

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


def _search_client_key(request: Request) -> str:
	"""Best-effort client key for the public embedding rate limit."""
	real_ip = request.headers.get('x-real-ip', '').strip()
	if real_ip:
		return real_ip

	forwarded_for = request.headers.get('x-forwarded-for', '').strip()
	if forwarded_for:
		return forwarded_for.split(',')[0].strip()

	if request.client:
		return request.client.host

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


@router.post('/embed', response_model=EmbedResponse)
def embed_query(payload: EmbedRequest, request: Request) -> EmbedResponse:
	"""Encode a text query into a pgvector literal for similarity ranking."""
	_check_search_embed_rate_limit(_search_client_key(request))

	query = payload.query.strip()
	if not query:
		raise HTTPException(status_code=400, detail='Query must not be empty')
	if len(query) > MAX_QUERY_LENGTH:
		raise HTTPException(status_code=400, detail=f'Query exceeds {MAX_QUERY_LENGTH} characters')

	try:
		vector = embed_text(query)
	except Exception as e:  # model load / inference failure
		logger.error(f'Failed to embed query: {e}', exc_info=True)
		raise HTTPException(status_code=503, detail='Search model unavailable')

	literal = '[' + ','.join(f'{v:.6f}' for v in vector) + ']'
	return EmbedResponse(embedding=literal, dim=EMBEDDING_DIM)
