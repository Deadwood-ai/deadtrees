"""The prediction quality check as an audit worker handler (audit_worker.worker.HANDLERS).

handle(ctx) reads the stored COG (private datasets too), the dataset's CLIP tiles, its AOI
and the preferred deadwood and forest predictions, asks the version's judges per tile, uploads
the images they saw and returns the run's p_result (payload.build), which the worker stores
with audit.finish_run. Which judge decides is the rules' (RULES_CONFIG), applied in the
database (audit.tile_calls).
"""

import tempfile
from pathlib import Path

from shapely.geometry import mapping, shape

from shared.labels import read_model_preferences
from shared.logger import logger
from shared.logging import LogCategory, LogContext
from shared.models import LabelDataEnum, LabelSourceEnum
from shared.pagination import iter_pages_by_creation
from shared.settings import settings

from ..utils.stored_inputs import (
	aoi_key,
	readable_cog,
	ortho_sha256,
	read_geometry,
	stored_aoi,
	stored_cog,
	tile_rows,
)
from . import payload
from .check import run_prediction_quality
from .judge import PROMPT_VERSION
from .render import CROP_PX, RENDER_VERSION
from .tiles import EXCLUDE_SET_SIZE, TILE_M, Tile

VERSION = 'v2'
CONFIG = {
	'models': {
		'luna-medium': {'transport': 'codex', 'model': 'gpt-6-luna', 'effort': 'medium'},
		'haiku-5.5': {'transport': 'claude', 'model': 'claude-haiku-5-5'},
	},
	'prompt_version': PROMPT_VERSION,
	'render': RENDER_VERSION,
	'tiles': {'picker': payload.PICKER, 'exclude_set': EXCLUDE_SET_SIZE, 'tile_m': TILE_M, 'crop_px': CROP_PX},
}
# audit.check_rules of the version: a tile's call is the deciding judge's verdict (by name prefix);
# the other judges are stored and shown, not counted
RULES = 'rules-v1'
RULES_CONFIG = {'decider': 'haiku'}
# The check's layer names and where each layer's prediction lives.
LAYERS = {
	'deadwood': (LabelDataEnum.deadwood, settings.deadwood_geometries_table),
	'forest': (LabelDataEnum.forest_cover, settings.forest_cover_geometries_table),
}

__all__ = ['CONFIG', 'RULES', 'RULES_CONFIG', 'VERSION', 'handle']


def identity(sha256: str, aoi: dict | None, label_ids: dict) -> dict:
	"""What a run judged, stored with it (audit.runs.inputs)."""
	return {
		'ortho_sha256': sha256,
		'aoi': aoi_key(aoi),
		'label_ids': {payload.LAYER_NAMES[layer]: label_id for layer, label_id in label_ids.items()},
	}


def handle(ctx) -> dict:
	# The code is the version: a run queued for an earlier version would be judged with this
	# drawing and prompt but stored under the earlier name. Such a run fails; an operator
	# activates this version and queues runs of it.
	queued_for = (getattr(ctx, 'version', None) or {}).get('version', VERSION)
	if queued_for != VERSION:
		raise ValueError(f'the run is of version {queued_for}; this code judges {VERSION}')
	dataset_id = ctx.run['dataset_id']
	client = ctx.client
	log = LogContext(
		category=LogCategory.PROCESS, dataset_id=dataset_id, token=ctx.token, extra={'run_id': ctx.run['id']}
	)
	cog = stored_cog(client, dataset_id)
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
	predictions = {layer: prediction_polygons(client, table, label_ids[layer]) for layer, (_, table) in LAYERS.items()}
	with (
		tempfile.TemporaryDirectory(prefix='prediction-quality-') as folder,
		readable_cog(cog, Path(folder), ctx.token, dataset_id, log) as cog_source,
	):
		result = run_prediction_quality(
			dataset_id, cog_source, tiles, shape(aoi) if aoi else None, predictions, ctx.judges
		)
	ctx.refresh()  # the judges can take longer than the login lasts
	p_result, files = payload.build(
		ctx.run['id'],
		result,
		# what was judged, read at run time: the ortho, AOI or predictions may have changed since queueing
		inputs=identity(sha256, aoi, label_ids),
		label_ids=label_ids,
		footprints={r['id']: mapping(r['geometry']) for r in rows},
	)
	# Files first, rows second: a stored row always points at an uploaded image.
	for path, data in files:
		ctx.put_image(path, data, dataset_id)
	logger.info(
		'Prediction quality judged',
		LogContext(
			category=LogCategory.PROCESS,
			dataset_id=dataset_id,
			token=ctx.token,
			extra={
				'run_id': ctx.run['id'],
				'tiles': len(p_result['tiles']),
				'judgements': len(p_result['tile_judgements']),
			},
		),
	)
	return p_result


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
	hundred thousand polygons, so the read continues after the last row instead of an offset."""
	pages = iter_pages_by_creation(
		lambda: client.table(table).select('id,created_at,geometry').eq('label_id', label_id).eq('is_deleted', False)
	)
	return [read_geometry(row['geometry']) for page in pages for row in page]
