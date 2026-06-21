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

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from shared.embedding_model import EMBEDDING_DIM, embed_text

logger = logging.getLogger(__name__)

router = APIRouter(prefix='/search', tags=['search'])

MAX_QUERY_LENGTH = 300


class EmbedRequest(BaseModel):
	query: str = Field(..., description='Free-text open-vocabulary search query')


class EmbedResponse(BaseModel):
	# pgvector text literal '[v1,v2,...]' ready to pass to the ranking RPCs.
	embedding: str = Field(..., description="CLIP text embedding as a pgvector literal")
	dim: int = Field(..., description='Embedding dimensionality')


@router.post('/embed', response_model=EmbedResponse)
def embed_query(request: EmbedRequest) -> EmbedResponse:
	"""Encode a text query into a pgvector literal for similarity ranking."""
	query = request.query.strip()
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
