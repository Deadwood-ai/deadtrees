"""Inputs of the stages and audit checks that run from stored outputs (date estimate,
georeferencing check, dataset evaluation, prediction quality)."""

import hashlib
import json
from pathlib import Path

from shapely import wkb
from shapely.geometry import shape

from shared.logger import logger
from shared.logging import LogContext
from shared.models import Cog
from shared.pagination import fetch_all_rows
from shared.settings import settings

from .ssh import pull_file_from_storage_server

AOI_SOURCE_PREFERENCE = {'manual_correction': 0, 'manual': 1, 'ml_prediction': 2}
NO_ORTHO_HASH = 'dataset has no ortho with a sha256; run the ortho stage first'


def select_aoi(aois: list[dict]) -> dict | None:
	"""The AOI to work in: an auditor's AOI before the predicted one, newest
	first; whole-image AOIs mean "no AOI"."""
	usable = [a for a in aois if a.get('geometry') and not a.get('is_whole_image')]
	if not usable:
		return None
	usable.sort(key=lambda a: a.get('created_at') or '', reverse=True)
	usable.sort(key=lambda a: AOI_SOURCE_PREFERENCE.get(a.get('source'), 3))
	return usable[0]['geometry']


def local_cog(cog: Cog, temp_dir: Path, token: str, dataset_id: int, ctx: LogContext) -> Path:
	"""The COG written by this run's cog stage, else the stored one."""
	local = temp_dir / cog.cog_file_name
	if local.exists():
		return local
	temp_dir.mkdir(parents=True, exist_ok=True)
	remote = f'{settings.STORAGE_SERVER_DATA_PATH}/{settings.COG_DIR}/{cog.cog_path}'
	logger.info(f'Pulling COG from {remote}', ctx)
	pull_file_from_storage_server(remote, str(local), token, dataset_id)
	return local


def ortho_sha256(client, dataset_id: int) -> str:
	"""The hash of the dataset's ortho: what an audit run's crops and images are stored under."""
	rows = client.table(settings.orthos_table).select('sha256').eq('dataset_id', dataset_id).execute().data
	if not rows or not rows[0].get('sha256'):
		raise ValueError(NO_ORTHO_HASH)
	return rows[0]['sha256']


def stored_aoi(client, dataset_id: int) -> dict | None:
	"""The dataset's AOI to work in (select_aoi), as stored GeoJSON."""
	aois = (
		client.table(settings.aois_table)
		.select('geometry,is_whole_image,source,created_at')
		.eq('dataset_id', dataset_id)
		.execute()
		.data
	)
	return select_aoi(aois)


def aoi_key(aoi: dict | None) -> str | None:
	"""A stable short id of an AOI, for the inputs an audit run records."""
	if not aoi:
		return None
	return hashlib.sha256(json.dumps(aoi, sort_keys=True).encode()).hexdigest()[:16]


def read_geometry(value):
	"""A geometry column as shapely; PostgREST returns it as GeoJSON or EWKB hex."""
	return shape(value) if isinstance(value, dict) else wkb.loads(bytes.fromhex(value))


def tile_rows(client, dataset_id: int) -> list[dict]:
	"""The dataset's CLIP tiles (none before the embedding stage has run): id, pixel window
	and the footprint as shapely."""
	rows = fetch_all_rows(
		lambda: (
			client.table(settings.tile_embeddings_table)
			.select('id,pixel_x0,pixel_y0,pixel_x1,pixel_y1,geometry')
			.eq('dataset_id', dataset_id)
			.order('id')
		)
	)
	return [{**row, 'geometry': read_geometry(row['geometry'])} for row in rows]
