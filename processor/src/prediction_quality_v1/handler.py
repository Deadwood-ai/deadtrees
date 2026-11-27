"""The prediction quality check as an audit worker handler (audit_worker.worker.HANDLERS).

handle(ctx) reads the stored COG (private datasets too), the dataset's AOI, a sample of its
CLIP tiles with their predicted cover and, for the picked tiles only, the polygons of the
preferred deadwood and forest predictions (the audit.prediction_quality_* reads), asks the
version's judges per tile, uploads the images they saw and returns the run's p_result
(payload.build), which the worker stores with audit.finish_run. Which judge decides is the
rules' (RULES_CONFIG), applied in the database (audit.tile_calls).
"""

import tempfile
from pathlib import Path

from shapely.geometry import shape

from shared.labels import read_model_preferences
from shared.logger import logger
from shared.logging import LogCategory, LogContext
from shared.models import LabelDataEnum, LabelSourceEnum
from shared.retry import is_statement_timeout
from shared.settings import settings

from ..utils.stored_inputs import aoi_key, ortho_sha256, readable_cog, stored_aoi, stored_cog
from . import payload
from .check import run_prediction_quality
from .judge import PROMPT_VERSION
from .render import CROP_PX, RENDER_VERSION
from .tiles import CANDIDATES, EXCLUDE_SET_SIZE, INSIDE_AOI, TILE_M, Tile

VERSION = 'v2'
CONFIG = {
	'models': {
		'luna-medium': {'transport': 'codex', 'model': 'gpt-6-luna', 'effort': 'medium'},
		'haiku-5.5': {'transport': 'claude', 'model': 'claude-haiku-5-5'},
	},
	'prompt_version': PROMPT_VERSION,
	'render': RENDER_VERSION,
	'tiles': {
		'picker': payload.PICKER,
		'candidates': CANDIDATES,
		'exclude_set': EXCLUDE_SET_SIZE,
		'tile_m': TILE_M,
		'crop_px': CROP_PX,
	},
}
# boxes per call of the cover and polygon reads to start with (read_boxes)
BOX_BATCH = 50
# audit.check_rules of the version: a tile's call is the deciding judge's verdict (by name prefix);
# the other judges are stored and shown, not counted
RULES = 'rules-v1'
RULES_CONFIG = {'decider': 'haiku'}
# The check's layer names and the prediction each judges.
LAYERS = {'deadwood': LabelDataEnum.deadwood, 'forest': LabelDataEnum.forest_cover}

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
	rpc = audit_rpc(client)
	candidates, tiles_total, footprints = read_candidates(rpc, dataset_id, aoi, label_ids)
	with (
		tempfile.TemporaryDirectory(prefix='prediction-quality-') as folder,
		readable_cog(cog, Path(folder), ctx.token, dataset_id, log) as cog_source,
	):
		result = run_prediction_quality(
			dataset_id,
			cog_source,
			candidates,
			tiles_total,
			shape(aoi) if aoi else None,
			polygons_near(rpc, label_ids),
			ctx.judges,
		)
	ctx.refresh()  # the judges can take longer than the login lasts
	p_result, files = payload.build(
		ctx.run['id'],
		result,
		# what was judged, read at run time: the ortho, AOI or predictions may have changed since queueing
		inputs=identity(sha256, aoi, label_ids),
		label_ids=label_ids,
		footprints=footprints,
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
	for layer, label_data in LAYERS.items():
		ids = [
			r['id']
			for r in rows
			if r['label_data'] == label_data.value and r['model_config'] == preferences[label_data]
		]
		if not ids:
			raise ValueError(f'dataset has no {label_data.value} prediction of the preferred model')
		found[layer] = max(ids)
	return found


def audit_rpc(client):
	"""rpc(function, params) -> the result of an audit.* function, through PostgREST."""
	return lambda function, params: client.schema('audit').rpc(function, params).execute().data


def read_candidates(rpc, dataset_id: int, aoi: dict | None, label_ids: dict) -> tuple[list[Tile], int, dict]:
	"""The tiles the sets are picked from: CANDIDATES of the dataset's CLIP tiles inside the AOI,
	drawn in a fixed order (audit.prediction_quality_candidates), with their predicted cover
	(audit.prediction_quality_cover on each footprint). Returns them, how many tiles lie inside
	the AOI, and each one's footprint (GeoJSON) by id."""
	found = rpc(
		'prediction_quality_candidates',
		{'p_dataset_id': dataset_id, 'p_aoi': aoi, 'p_limit': CANDIDATES, 'p_inside': INSIDE_AOI},
	)
	if not found['tiles']:
		raise ValueError('dataset has no CLIP tiles; run the embedding stage first')
	tiles = [
		Tile(tile_id=c['id'], pixel_window=tuple(c['pixel_window']), bbox_4326=shape(c['geometry']).bounds)
		for c in found['candidates']
	]
	boxes = [t.bbox_4326 for t in tiles]  # the footprints are envelopes
	deadwood = read_boxes(rpc, 'prediction_quality_cover', label_ids['deadwood'], boxes)
	forest = read_boxes(rpc, 'prediction_quality_cover', label_ids['forest'], boxes)
	for t, dw, fc in zip(tiles, deadwood, forest):
		t.deadwood_share, t.forest_share = dw, fc
	return tiles, found['tiles_inside'], {c['id']: c['geometry'] for c in found['candidates']}


def polygons_near(rpc, label_ids: dict):
	"""polygons(layer, boxes) for the check: per WGS84 box, the layer's prediction cut to it
	(audit.prediction_quality_polygons), as shapely."""

	def polygons(layer: str, boxes: list) -> list:
		found = read_boxes(rpc, 'prediction_quality_polygons', label_ids[layer], boxes)
		return [[shape(g) for g in cut] for cut in found]

	return polygons


def read_boxes(rpc, function: str, label_id: int, boxes: list, size: int = BOX_BATCH) -> list:
	"""function(p_label_id, p_boxes) for every box, one result per box, in calls of at most
	size boxes. Each call must end within the login's statement timeout (8 s in production),
	and one box of a large prediction can take a second: a call that times out is made again
	with half the boxes, and the calls after it keep the smaller size. A single box that
	still times out fails the run."""
	found: list = []
	while len(found) < len(boxes):
		part = [list(b) for b in boxes[len(found) : len(found) + size]]
		try:
			result = rpc(function, {'p_label_id': label_id, 'p_boxes': part})
		except Exception as e:
			if not is_statement_timeout(e):
				raise
			if size == 1:
				raise RuntimeError(
					f'audit.{function} of label {label_id} exceeds the statement timeout on a single box {part[0]}'
				) from e
			size //= 2
			continue
		if len(result) != len(part):
			raise RuntimeError(f'audit.{function} answered {len(result)} boxes of {len(part)}')
		found += result
	return found
