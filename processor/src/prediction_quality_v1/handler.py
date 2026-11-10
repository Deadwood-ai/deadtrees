"""The prediction quality check as an audit worker handler (audit_worker.worker.HANDLERS).

handle(ctx) reads the stored COG (private datasets too), the dataset's CLIP tiles, its AOI
and the preferred deadwood and forest predictions, asks the version's judges per crop, and
stores crops, images and assessments (store.write). The worker finishes the run with the
returned evidence, coverage and cost, and points the dataset at it when the version is active.
"""

import tempfile
from pathlib import Path

from shapely.geometry import mapping, shape

from shared.labels import read_model_preferences
from shared.logger import logger
from shared.logging import LogCategory, LogContext
from shared.models import Cog, LabelDataEnum, LabelSourceEnum
from shared.pagination import iter_pages_after_id
from shared.settings import settings

from ..audit_worker.worker import default_ready
from ..utils.stored_inputs import aoi_key, local_cog, ortho_sha256, read_geometry, stored_aoi, tile_rows
from . import store
from .check import run_prediction_quality
from .judge import PROMPT_VERSION
from .render import CROP_PX
from .rule import CROP_MAJOR_CUT, MIN_MAJOR_CROPS, RULE_VERSION
from .tiles import EXCLUDE_SET_SIZE, TILE_M, Tile

VERSION = 'v1'
CONFIG = {
	'models': {
		'luna-medium': {'transport': 'codex', 'model': 'gpt-6-luna', 'effort': 'medium'},
		'haiku-5.5': {'transport': 'claude', 'model': 'claude-haiku-5-5'},
	},
	'prompt_version': PROMPT_VERSION,
	'rule': RULE_VERSION,
	'rule_config': {'crop_major_cut': CROP_MAJOR_CUT, 'min_major_crops': MIN_MAJOR_CROPS},
	'crops': {'picker': store.SELECTED_BY, 'exclude_set': EXCLUDE_SET_SIZE, 'tile_m': TILE_M, 'crop_px': CROP_PX},
}
# The check's layer names and where each layer's prediction lives.
LAYERS = {
	'deadwood': (LabelDataEnum.deadwood, settings.deadwood_geometries_table),
	'forest': (LabelDataEnum.forest_cover, settings.forest_cover_geometries_table),
}
JUDGE_WORKERS = 4

__all__ = ['CONFIG', 'VERSION', 'handle', 'inputs', 'ready']


def ready(status: dict) -> bool:
	"""After the COG and both predictions exist (the worker's default), and the CLIP tiles."""
	return bool(default_ready(status) and status.get('is_embeddings_done'))


def inputs(client, dataset_id: int) -> dict:
	"""What a run judges: a new ortho, AOI or prediction makes a new run (and reopens a review)."""
	return identity(
		ortho_sha256(client, dataset_id), stored_aoi(client, dataset_id), prediction_labels(client, dataset_id)
	)


def identity(sha256: str, aoi: dict | None, label_ids: dict) -> dict:
	"""The one shape of a run's inputs. The worker compares it with the stored run to tell
	whether a dataset was already judged, so the queueing and the run must build it alike."""
	return {
		'ortho_sha256': sha256,
		'aoi': aoi_key(aoi),
		'label_ids': {store.LAYER_NAMES[layer]: label_id for layer, label_id in label_ids.items()},
	}


def handle(ctx) -> dict:
	dataset_id = ctx.run['dataset_id']
	client = ctx.client
	log = LogContext(
		category=LogCategory.PROCESS, dataset_id=dataset_id, token=ctx.token, extra={'run_id': ctx.run['id']}
	)
	cogs = client.table(settings.cogs_table).select('*').eq('dataset_id', dataset_id).execute().data
	if not cogs:
		raise ValueError('dataset has no COG; run the cog stage first')
	sha256 = ortho_sha256(client, dataset_id)
	aoi = stored_aoi(client, dataset_id)
	label_ids = prediction_labels(client, dataset_id)
	rows = tile_rows(client, dataset_id)
	if not rows:
		raise ValueError('dataset has no CLIP tiles; run the embedding stage first')
	tiles = [
		Tile(
			tile_id=r['id'],
			pixel_window=(r['pixel_x0'], r['pixel_y0'], r['pixel_x1'], r['pixel_y1']),
			bbox_4326=r['geometry'].bounds,
		)
		for r in rows
	]
	footprints = {r['id']: mapping(r['geometry']) for r in rows}
	polygons = {layer: prediction_polygons(client, table, label_ids[layer]) for layer, (_, table) in LAYERS.items()}
	with tempfile.TemporaryDirectory(prefix='prediction-quality-') as folder:
		cog_file = local_cog(Cog(**cogs[0]), Path(folder), ctx.token, dataset_id, log)
		result = run_prediction_quality(
			dataset_id,
			str(cog_file),
			tiles,
			shape(aoi) if aoi else None,
			polygons['deadwood'],
			polygons['forest'],
			ctx.judges,
			workers=JUDGE_WORKERS,
		)
	stored = store.write(
		client,
		ctx.run['id'],
		result,
		ortho_sha256=sha256,
		label_ids=label_ids,
		footprint=lambda tile: footprints[tile.tile_id],
		put_image=ctx.put_image,
	)
	logger.info(
		'Prediction quality stored',
		LogContext(
			category=LogCategory.PROCESS,
			dataset_id=dataset_id,
			token=ctx.token,
			extra={
				'run_id': ctx.run['id'],
				**stored,
				'verdicts': {layer: verdict['verdict'] for layer, verdict in result.verdicts.items()},
			},
		),
	)
	# inputs: what was judged, read at run time (the ortho, AOI or predictions may have changed since queueing)
	return {'inputs': identity(sha256, aoi, label_ids), **store.summary(result)}


def prediction_labels(client, dataset_id: int) -> dict:
	"""The check's layer -> the dataset's active prediction of the preferred model (the newest one)."""
	preferences = read_model_preferences(client)
	rows = (
		client.table(settings.labels_table)
		.select('id,label_data,model_config')
		.eq('dataset_id', dataset_id)
		.eq('label_source', LabelSourceEnum.model_prediction.value)
		.eq('is_active', True)
		.execute()
		.data
	)
	found = {}
	for layer, (label_data, _) in LAYERS.items():
		ids = [
			r['id']
			for r in rows
			if r['label_data'] == label_data.value and r['model_config'] == preferences[label_data]
		]
		if not ids:
			raise ValueError(f'dataset has no {label_data.value} prediction of the preferred model')
		found[layer] = max(ids)
	return found


def prediction_polygons(client, table: str, label_id: int) -> list:
	"""Every polygon of one prediction, as shapely in WGS84. Large predictions hold a few
	hundred thousand polygons, so the read continues after the last id instead of an offset."""
	pages = iter_pages_after_id(
		lambda: client.table(table).select('id,geometry').eq('label_id', label_id).eq('is_deleted', False)
	)
	return [read_geometry(row['geometry']) for page in pages for row in page]
