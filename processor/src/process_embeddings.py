from pathlib import Path
from typing import List

from shared.db import use_client, login, login_verified
from shared.settings import settings
from shared.models import StatusEnum, Ortho, QueueTask
from shared.logger import logger
from shared.status import update_status
from shared.logging import LogContext, LogCategory
from shared.embedding_model import load_openclip, tile_background_sims

from .utils.local_ortho import ensure_local_ortho
from .embedding_search import embed_orthophoto_tiles, PatchEmbedding
from .exceptions import AuthenticationError, DatasetError, ProcessingError

# Insert tile rows in chunks to keep PostgREST request bodies reasonable.
_INSERT_CHUNK_SIZE = 200


def _embedding_to_pgvector(embedding) -> str:
	"""pgvector parses this bracketed string literal via an explicit ::vector cast."""
	return '[' + ','.join(f'{float(v):.6f}' for v in embedding) + ']'


def _rows_from_embeddings(embeddings: List[PatchEmbedding], bg_sims) -> List[dict]:
	"""JSON rows for the insert_tile_embeddings RPC (casts to vector/geometry)."""
	rows = []
	for i, patch in enumerate(embeddings):
		min_lon, min_lat, max_lon, max_lat = patch.geo_bbox_4326
		x0, y0, x1, y1 = patch.pixel_bbox
		rows.append(
			{
				'min_lon': min_lon,
				'min_lat': min_lat,
				'max_lon': max_lon,
				'max_lat': max_lat,
				'embedding': _embedding_to_pgvector(patch.embedding),
				'pixel_x0': x0,
				'pixel_y0': y0,
				'pixel_x1': x1,
				'pixel_y1': y1,
				'nodata_fraction': round(float(patch.nodata_fraction), 4),
				# Calibration: cosine sims to the fixed background prompt bank.
				'bg_sims': [round(float(v), 6) for v in bg_sims[i]],
			}
		)
	return rows


def process_embeddings(task: QueueTask, token: str, temp_dir: Path):
	"""Compute per-tile CLIP embeddings for a dataset and store them for search.

	Mirrors the segmentation stages: resolve the ortho, ensure it is available
	locally, reproject to 10cm, embed each <50% nodata tile with OpenCLIP
	ViT-H/14, and replace any existing rows in ``v2_tile_embeddings``.
	"""
	import torch

	token, user = login_verified(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
	if not user:
		logger.error(
			'Invalid processor token',
			LogContext(category=LogCategory.AUTH, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
		)
		raise AuthenticationError('Invalid token')

	try:
		with use_client(token) as client:
			response = client.table(settings.orthos_table).select('*').eq('dataset_id', task.dataset_id).execute()
			ortho = Ortho(**response.data[0])
	except Exception as e:
		logger.error(
			'Failed to fetch ortho data',
			LogContext(
				category=LogCategory.EMBEDDINGS,
				dataset_id=task.dataset_id,
				user_id=user.id,
				token=token,
				extra={'error': str(e)},
			),
		)
		raise DatasetError(f'Error fetching dataset: {e}')

	update_status(token, dataset_id=ortho.dataset_id, current_status=StatusEnum.embedding_processing)
	logger.info(
		'Starting tile embedding',
		LogContext(category=LogCategory.EMBEDDINGS, dataset_id=task.dataset_id, user_id=user.id, token=token),
	)

	file_path = Path(temp_dir) / ortho.ortho_file_name
	ensure_local_ortho(
		local_path=file_path,
		ortho_file_name=ortho.ortho_file_name,
		token=token,
		dataset_id=ortho.dataset_id,
		log_context=LogContext(
			category=LogCategory.EMBEDDINGS,
			dataset_id=task.dataset_id,
			user_id=user.id,
			token=token,
			extra={'file_path': str(file_path)},
		),
	)

	try:
		device = 'cuda' if torch.cuda.is_available() else 'cpu'
		logger.info(
			f'Loading OpenCLIP model on {device}',
			LogContext(category=LogCategory.EMBEDDINGS, dataset_id=task.dataset_id, user_id=user.id, token=token),
		)
		bundle = load_openclip(device=device)

		embeddings = embed_orthophoto_tiles(file_path, bundle)

		# Per-tile cosine sims to the background prompt bank (for score calibration).
		import numpy as np

		emb_matrix = (
			np.stack([p.embedding for p in embeddings]) if embeddings else np.zeros((0, 1), dtype=np.float32)
		)
		bg_sims = tile_background_sims(emb_matrix, bundle=bundle) if embeddings else []

		if torch.cuda.is_available():
			torch.cuda.empty_cache()

		# Inference + model load can exceed the JWT lifetime; refresh before DB writes.
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

		# Replace any previous embeddings for this dataset (idempotent reruns).
		# The delete goes through the table (RLS allows the processor); inserts go
		# through the RPC so vector/geometry casting happens server-side.
		rows = _rows_from_embeddings(embeddings, bg_sims)
		with use_client(token) as client:
			client.table(settings.tile_embeddings_table).delete().eq('dataset_id', ortho.dataset_id).execute()

			for start in range(0, len(rows), _INSERT_CHUNK_SIZE):
				client.rpc(
					'insert_tile_embeddings',
					{'p_dataset_id': ortho.dataset_id, 'p_rows': rows[start : start + _INSERT_CHUNK_SIZE]},
				).execute()

		logger.info(
			f'Stored {len(embeddings)} tile embeddings',
			LogContext(category=LogCategory.EMBEDDINGS, dataset_id=task.dataset_id, user_id=user.id, token=token),
		)

		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		update_status(token, dataset_id=ortho.dataset_id, current_status=StatusEnum.idle, is_embeddings_done=True)

		logger.info(
			'Tile embedding completed successfully',
			LogContext(category=LogCategory.EMBEDDINGS, dataset_id=task.dataset_id, user_id=user.id, token=token),
		)

	except Exception as e:
		if torch.cuda.is_available():
			torch.cuda.empty_cache()
		logger.error(
			'Tile embedding failed',
			LogContext(
				category=LogCategory.EMBEDDINGS,
				dataset_id=ortho.dataset_id,
				user_id=user.id,
				token=token,
				extra={'error': str(e)},
			),
		)
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		update_status(token, dataset_id=ortho.dataset_id, has_error=True, error_message=str(e))
		raise ProcessingError(str(e), task_type='embedding_processing', task_id=task.id, dataset_id=ortho.dataset_id)
