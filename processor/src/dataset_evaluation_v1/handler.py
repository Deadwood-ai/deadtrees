"""The dataset evaluation as an audit worker handler (audit_worker.worker.HANDLERS).

handle(ctx) reads the stored COG (private datasets too), its CLIP tiles and the
thumbnail, asks the version's judges, uploads the judged images with ctx.put_image and
returns the run's p_result (check.payload), which the worker stores with
audit.finish_run. Keep or exclude is worked out in the database from the stored answers
with the version's rules (RULES_CONFIG, audit.evaluation_calls).
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
	readable_cog,
	stored_cog,
	tile_rows,
)
from .check import CONFIG, evaluate, image_path, payload
from .inputs import Tile, read_inputs

# v3: the prompt and images of v2, which judged the orthophoto alone; v1 judged inside the
# AOI, which is a check of its own (DT-1538).
VERSION = 'v3'
# audit.check_rules of the version: the deciding model's verdict (by name prefix) keeps or
# excludes, a band check at band_major_at or more excludes as not RGB, an empty COG as a
# broken ortho; the other models are stored and shown, not counted
RULES = 'rules-v1'
RULES_CONFIG = {'decider': 'haiku', 'band_major_at': 90}

__all__ = ['CONFIG', 'RULES', 'RULES_CONFIG', 'VERSION', 'handle']


def identity(sha256: str) -> dict:
	"""What a run judged, stored with it (audit.runs.inputs)."""
	return {'ortho_sha256': sha256}


def handle(ctx) -> dict:
	# The code is the version: its prompt and sampling under an earlier version's name would mix
	# two behaviours in that version's results. Such a run fails; an operator activates this version.
	queued_for = (getattr(ctx, 'version', None) or {}).get('version', VERSION)
	if queued_for != VERSION:
		raise ValueError(f'the run is of version {queued_for}; this code judges {VERSION}')
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
	evaluation = evaluate(seen, ctx.judges, source_profile=(ortho.ortho_info or {}).get('Profile'), thumbnail=thumbnail)
	ctx.refresh()  # the judges can take longer than the login lasts
	# Files first, rows second: a stored row always points at an uploaded image.
	for image in evaluation.images:
		ctx.put_image(image_path(dataset_id, ctx.run['id'], image), image.data, dataset_id)
	logger.info(
		'Dataset evaluation judged',
		LogContext(
			category=LogCategory.PROCESS,
			dataset_id=dataset_id,
			token=ctx.token,
			extra={'run_id': ctx.run['id'], 'verdicts': {j.judge: j.verdict for j in evaluation.judgements}},
		),
	)
	# what was judged, read at run time: the ortho may have changed since the run was queued
	return payload(evaluation, seen, dataset_id, ctx.run['id'], identity(ortho.sha256))


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
