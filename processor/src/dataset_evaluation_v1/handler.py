"""The dataset evaluation as an audit worker handler (audit_worker.worker.HANDLERS).

handle(ctx) reads the stored COG (private datasets too), its CLIP tiles and the
thumbnail, asks the version's judges, uploads the judged images with ctx.put_image and
stores crops, images and assessments in one call to audit.store_dataset_evaluation.
recompute(ctx) runs this version's rule alone over an earlier run's stored answers (a
rule-only run). The worker finishes the run with the returned evidence, coverage and
cost, and points the dataset at it when the version is active.
"""

import tempfile
from pathlib import Path

from shared.logger import logger
from shared.logging import LogCategory, LogContext
from shared.models import Ortho
from shared.settings import settings

from ..utils.ssh import pull_file_from_storage_server
from ..utils.stored_inputs import (
	NO_ORTHO_HASH,
	ortho_sha256,
	readable_cog,
	stored_cog,
	tile_rows,
)
from .check import CONFIG, evaluate, rule_only_verdict, store_payload
from .inputs import Tile, read_inputs
from .vocabulary import CHECK_KEY, LAYER

# v3: the dataset rule without the duplicate check, and the COG and thumbnail issues as the
# rule row's output (the prompt and images of v2). v2 judged the orthophoto alone; v1 judged
# inside the AOI, which is a check of its own (DT-1538).
VERSION = 'v3'

__all__ = ['CONFIG', 'VERSION', 'handle', 'inputs', 'ready', 'recompute']


def ready(status: dict) -> bool:
	"""After the COG, thumbnail and CLIP tiles exist; predictions are not needed."""
	return bool(status.get('is_cog_done') and status.get('is_thumbnail_done') and status.get('is_embeddings_done'))


def inputs(client, dataset_id: int) -> dict:
	"""What a run judges: a new ortho makes a new run (and reopens a review). The AOI and the
	predictions play no part, so changing them does not."""
	return identity(ortho_sha256(client, dataset_id))


def identity(sha256: str) -> dict:
	"""The one shape of a run's inputs. The worker compares it with the stored run to tell
	whether a dataset was already judged, so the queueing and the run must build it alike."""
	return {'ortho_sha256': sha256}


def version_config(ctx) -> dict:
	"""The config of the run's version; refuses a run of another version.

	The code is the version: its prompt, sampling and rule under an earlier version's name would
	mix two behaviours in that version's results. Such a run fails; an operator activates this
	version. The thresholds are the ones the version was registered with (a version before they
	were recorded runs with today's)."""
	version = getattr(ctx, 'version', None) or {}
	queued_for = version.get('version', VERSION)
	if queued_for != VERSION:
		raise ValueError(f'the run is of version {queued_for}; this code judges {VERSION}')
	return {**CONFIG, **version.get('config', {})}


def handle(ctx) -> dict:
	config = version_config(ctx)
	dataset_id = ctx.run['dataset_id']
	client = ctx.client
	log = LogContext(
		category=LogCategory.PROCESS, dataset_id=dataset_id, token=ctx.token, extra={'run_id': ctx.run['id']}
	)
	cog = stored_cog(client, dataset_id)
	ortho = _ortho(client, dataset_id)
	with (
		tempfile.TemporaryDirectory(prefix='dataset-evaluation-') as folder,
		readable_cog(cog, Path(folder), ctx.token, dataset_id, log) as cog_source,
	):
		thumbnail = _thumbnail(client, dataset_id, Path(folder), ctx.token)
		seen = read_inputs(cog_source, seed=dataset_id, tiles=tiles(client, dataset_id))
	evaluation = evaluate(
		seen,
		ctx.judges,
		source_profile=(ortho.ortho_info or {}).get('Profile'),
		thumbnail=thumbnail,
		rule_config=config['rule_config'],
	)
	payload = store_payload(evaluation, seen, dataset_id, ortho.sha256)
	# Files first, rows second: a stored row always points at an uploaded image.
	for image, row in zip(evaluation.images, payload['images']):
		ctx.put_image(row['storage_path'], image.data, dataset_id)
	crop_ids = (
		client.schema('audit')
		.rpc('store_dataset_evaluation', {'p_run_id': ctx.run['id'], 'p_result': payload})
		.execute()
		.data
	)
	# The run names what it judged. Crops and images are stored per ortho, and an ortho a
	# version 1 run judged inside its AOI holds that run's crops and overview too.
	judged = {
		'crop_ids': crop_ids or [],
		'images': [{k: row[k] for k in ('kind', 'crop_index', 'storage_path', 'sha256')} for row in payload['images']],
	}
	verdict = evaluation.verdict
	logger.info(
		'Dataset evaluation stored',
		LogContext(
			category=LogCategory.PROCESS,
			dataset_id=dataset_id,
			token=ctx.token,
			extra={'run_id': ctx.run['id'], 'verdict': verdict.verdict, 'why': verdict.details.get('why')},
		),
	)
	return {
		# what was judged, read at run time: the ortho may have changed since the run was queued
		'inputs': identity(ortho.sha256),
		'evidence': {**evaluation.evidence, 'judged': judged},
		'coverage': {'crops': len(seen.crops), 'crop_picker': seen.settings['crop_picker']},
		'cost': evaluation.cost,
	}


def recompute(ctx) -> dict:
	"""A rule-only run (run.source_run_id): this version's rule over the source run's stored
	model answers and band check, no model call. It stores only the new rule row;
	audit.current_assessments adds the source run's model rows to it. The run takes over the
	source's inputs, evidence and coverage, so it counts as judging the same evidence and the
	review page finds the crops and images the answers were given on."""
	config = version_config(ctx)
	audit = ctx.client.schema('audit')
	source_id = ctx.run['source_run_id']
	source = audit.table('runs').select('status, inputs, evidence, coverage').eq('id', source_id).execute().data
	if not source or source[0]['status'] != 'done':
		raise ValueError(f'source run {source_id} has not finished; there are no answers to recompute from')
	rows = (
		audit.table('assessments')
		.select('assessor_kind, model, prompt_version, verdict, major_likelihood, modes, details')
		.eq('run_id', source_id)
		.is_('crop_id', 'null')
		.order('id')
		.execute()
		.data
	)
	verdict = rule_only_verdict(rows, source[0]['evidence'], config['rule_config'])
	audit.table('assessments').insert(
		{'check_key': CHECK_KEY, 'dataset_id': ctx.run['dataset_id'], 'run_id': ctx.run['id'], 'layer': LAYER}
		| verdict.row()
	).execute()
	logger.info(
		'Dataset evaluation recomputed',
		LogContext(
			category=LogCategory.PROCESS,
			dataset_id=ctx.run['dataset_id'],
			token=ctx.token,
			extra={'run_id': ctx.run['id'], 'source_run_id': source_id, 'verdict': verdict.verdict},
		),
	)
	return {key: source[0][key] for key in ('inputs', 'evidence', 'coverage')}


def tile_of(row: dict) -> Tile:
	"""A tile row (stored_inputs.tile_rows) as the window and centre the crop picker reads."""
	minx, miny, maxx, maxy = row['geometry'].bounds
	return Tile(
		(row['pixel_x0'], row['pixel_y0'], row['pixel_x1'], row['pixel_y1']), ((minx + maxx) / 2, (miny + maxy) / 2)
	)


def tiles(client, dataset_id: int) -> list[Tile]:
	return [tile_of(r) for r in tile_rows(client, dataset_id)]


def _ortho(client, dataset_id: int) -> Ortho:
	rows = client.table(settings.orthos_table).select('*').eq('dataset_id', dataset_id).execute().data
	if not rows or not rows[0].get('sha256'):
		raise ValueError(NO_ORTHO_HASH)
	return Ortho(**rows[0])


def _thumbnail(client, dataset_id: int, folder: Path, token: str) -> bytes | None:
	"""The stored thumbnail the website shows, or None when the dataset has none."""
	rows = client.table(settings.thumbnails_table).select('thumbnail_path').eq('dataset_id', dataset_id).execute().data
	if not rows:
		return None
	local = folder / f'thumbnail-{Path(rows[0]["thumbnail_path"]).name}'
	remote = f'{settings.STORAGE_SERVER_DATA_PATH}/{settings.THUMBNAIL_DIR}/{rows[0]["thumbnail_path"]}'
	pull_file_from_storage_server(remote, str(local), token, dataset_id)
	return local.read_bytes()
