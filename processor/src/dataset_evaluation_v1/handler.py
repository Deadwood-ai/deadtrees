"""The dataset evaluation as an audit worker handler (audit_worker.worker.HANDLERS).

handle(ctx) reads the stored COG (private datasets too), its CLIP tiles, the
thumbnail and the duplicate candidates, asks the version's judges, uploads the judged
images with ctx.put_image and stores crops, images and assessments in one call to
audit.store_dataset_evaluation. The worker finishes the run with the returned
evidence, coverage and cost, and points the dataset at it when the version is active.
"""

import hashlib
import json
import tempfile
from pathlib import Path

from shapely import wkb
from shapely.geometry import shape

from shared.logger import logger
from shared.logging import LogCategory, LogContext
from shared.models import Cog, Ortho
from shared.pagination import fetch_all_rows
from shared.settings import settings

from ..utils.ssh import pull_file_from_storage_server
from ..utils.stored_inputs import local_cog, select_aoi
from .check import CONFIG, evaluate, store_payload
from .inputs import Tile, read_inputs
from .rules import PHASH_METHOD, phash

VERSION = 'v1'

NO_ORTHO_HASH = 'dataset has no ortho with a sha256; run the ortho stage first'

__all__ = ['CONFIG', 'VERSION', 'handle', 'inputs', 'ready']


def ready(status: dict) -> bool:
	"""After the COG, thumbnail and CLIP tiles exist; predictions are not needed."""
	return bool(status.get('is_cog_done') and status.get('is_thumbnail_done') and status.get('is_embeddings_done'))


def inputs(client, dataset_id: int) -> dict:
	"""What a run judges: a new ortho or AOI makes a new run (and reopens a review)."""
	rows = client.table(settings.orthos_table).select('sha256').eq('dataset_id', dataset_id).execute().data
	if not rows or not rows[0].get('sha256'):
		raise ValueError(NO_ORTHO_HASH)
	return identity(rows[0]['sha256'], _aoi(client, dataset_id))


def identity(ortho_sha256: str, aoi: dict | None) -> dict:
	"""The one shape of a run's inputs. The worker compares it with the stored run to tell
	whether a dataset was already judged, so the queueing and the run must build it alike."""
	return {'ortho_sha256': ortho_sha256, 'aoi': aoi_key(aoi)}


def handle(ctx) -> dict:
	dataset_id = ctx.run['dataset_id']
	client = ctx.client
	log = LogContext(
		category=LogCategory.PROCESS, dataset_id=dataset_id, token=ctx.token, extra={'run_id': ctx.run['id']}
	)
	cogs = client.table(settings.cogs_table).select('*').eq('dataset_id', dataset_id).execute().data
	if not cogs:
		raise ValueError('dataset has no COG; run the cog stage first')
	ortho = _ortho(client, dataset_id)
	aoi = _aoi(client, dataset_id)
	with tempfile.TemporaryDirectory(prefix='dataset-evaluation-') as folder:
		cog_file = local_cog(Cog(**cogs[0]), Path(folder), ctx.token, dataset_id, log)
		thumbnail = _thumbnail(client, dataset_id, Path(folder), ctx.token)
		seen = read_inputs(str(cog_file), aoi, seed=dataset_id, tiles=tiles(client, dataset_id))
	# The thresholds the version was registered with (a version before they were recorded runs with today's).
	config = {**CONFIG, **(getattr(ctx, 'version', None) or {}).get('config', {})}
	image_hash, candidates = None, []
	if not seen.empty:  # an empty COG is excluded by rule; there is nothing to compare
		image_hash = phash(seen.overview, seen.valid)
		candidates = (
			client.schema('audit')
			.rpc(
				'duplicate_candidates',
				{
					'p_dataset_id': dataset_id,
					'p_hash': image_hash,
					'p_method': PHASH_METHOD,
					'p_max_hamming': config['duplicates']['max_hamming'],
					'p_min_overlap': config['duplicates']['min_overlap'],
				},
			)
			.execute()
			.data
		)
	evaluation = evaluate(
		seen,
		ctx.judges,
		source_profile=(ortho.ortho_info or {}).get('Profile'),
		image_hash=image_hash,
		duplicate_candidates=candidates or [],
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
	# The run names what it judged. Crops and images are stored per ortho, so after a run
	# with another AOI the ortho holds more crops than this run saw and keeps the first overview.
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
		# what was judged, read at run time: the ortho or AOI may have changed since the run was queued
		'inputs': identity(ortho.sha256, aoi),
		'evidence': {**evaluation.evidence, 'judged': judged},
		'coverage': {'crops': len(seen.crops), 'crop_picker': seen.settings['crop_picker']},
		'cost': evaluation.cost,
	}


def aoi_key(aoi: dict | None) -> str | None:
	"""A stable short id of the AOI the run judged."""
	if not aoi:
		return None
	return hashlib.sha256(json.dumps(aoi, sort_keys=True).encode()).hexdigest()[:16]


def tile_of(row: dict) -> Tile:
	"""A v2_tile_embeddings row as a Tile; PostgREST returns the footprint as GeoJSON or EWKB hex."""
	g = row['geometry']
	footprint = shape(g) if isinstance(g, dict) else wkb.loads(bytes.fromhex(g))
	minx, miny, maxx, maxy = footprint.bounds
	return Tile(
		(row['pixel_x0'], row['pixel_y0'], row['pixel_x1'], row['pixel_y1']), ((minx + maxx) / 2, (miny + maxy) / 2)
	)


def tiles(client, dataset_id: int) -> list[Tile]:
	"""The dataset's CLIP tiles (none before the embedding stage has run)."""
	rows = fetch_all_rows(
		lambda: (
			client.table(settings.tile_embeddings_table)
			.select('pixel_x0,pixel_y0,pixel_x1,pixel_y1,geometry')
			.eq('dataset_id', dataset_id)
			.order('id')
		)
	)
	return [tile_of(r) for r in rows]


def _ortho(client, dataset_id: int) -> Ortho:
	rows = client.table(settings.orthos_table).select('*').eq('dataset_id', dataset_id).execute().data
	if not rows or not rows[0].get('sha256'):
		raise ValueError(NO_ORTHO_HASH)
	return Ortho(**rows[0])


def _aoi(client, dataset_id: int) -> dict | None:
	aois = (
		client.table(settings.aois_table)
		.select('geometry,is_whole_image,source,created_at')
		.eq('dataset_id', dataset_id)
		.execute()
		.data
	)
	return select_aoi(aois)


def _thumbnail(client, dataset_id: int, folder: Path, token: str) -> bytes | None:
	"""The stored thumbnail the website shows, or None when the dataset has none."""
	rows = client.table(settings.thumbnails_table).select('thumbnail_path').eq('dataset_id', dataset_id).execute().data
	if not rows:
		return None
	local = folder / f'thumbnail-{Path(rows[0]["thumbnail_path"]).name}'
	remote = f'{settings.STORAGE_SERVER_DATA_PATH}/{settings.THUMBNAIL_DIR}/{rows[0]["thumbnail_path"]}'
	pull_file_from_storage_server(remote, str(local), token, dataset_id)
	return local.read_bytes()
