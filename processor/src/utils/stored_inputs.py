"""Inputs of the stages and audit checks that run from stored outputs (date estimate,
georeferencing check, dataset evaluation, prediction quality)."""

import hashlib
import json
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import httpx
import rasterio
from rasterio.errors import RasterioIOError

from shapely import wkb
from shapely.geometry import shape

from shared.logger import logger
from shared.logging import LogContext
from shared.models import Cog
from shared.pagination import iter_pages_by_id
from shared.settings import settings

from .ssh import pull_file_from_storage_server

AOI_SOURCE_PREFERENCE = {'manual_correction': 0, 'manual': 1, 'ml_prediction': 2}
NO_ORTHO_HASH = 'dataset has no ortho with a sha256; run the ortho stage first'


def select_aoi(aois: list[dict]) -> dict | None:
	"""The AOI to work in: an auditor's AOI before the predicted one, newest
	first; whole-image AOIs and empty ones (the model found no usable area) mean
	"no AOI", so the stages read the whole ortho."""
	usable = [a for a in aois if (a.get('geometry') or {}).get('coordinates') and not a.get('is_whole_image')]
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


STREAM_ENV = dict(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_TIMEOUT='60', GDAL_HTTP_MAX_RETRY='2')
STREAMED = '<streamed COG>'  # stands in for the link in errors: a private COG's link carries a ticket


def cog_url(cog: Cog, token: str, dataset_id: int) -> str | None:
	"""The COG as a link that serves range requests, so a check reads only the overview and
	crops it needs instead of the whole file. A private COG gets a signed link from the API (the
	processor may view every private dataset); a public or view-only one keeps its static URL.
	None when the API cannot be asked."""
	api = settings.API_ENDPOINT.rstrip('/')
	try:
		response = httpx.post(
			f'{api}/datasets/files/tickets',
			json={'dataset_ids': [dataset_id]},
			headers={'Authorization': f'Bearer {token}'},
			timeout=30,
		)
		response.raise_for_status()
		signed = (response.json().get('files') or {}).get(str(dataset_id)) or {}
	except (httpx.HTTPError, ValueError):
		return None
	if signed.get('cog_url'):
		return api + signed['cog_url']
	return api.removesuffix('/api/v1') + '/cogs/v1/' + cog.cog_path


@contextmanager
def readable_cog(cog: Cog, temp_dir: Path, token: str, dataset_id: int, ctx: LogContext) -> Iterator[str]:
	"""Where a check reads the COG from: its link, streamed with range requests, else (no link,
	or the link does not open) a copy of the whole file. Errors raised while the streamed COG is
	read name it without its link."""
	url = cog_url(cog, token, dataset_id)
	if url:
		try:
			with rasterio.Env(**STREAM_ENV), rasterio.open(url):
				pass
		except RasterioIOError:
			logger.warning('The COG link did not open; copying the file instead', ctx)
			url = None
	if not url:
		yield str(local_cog(cog, temp_dir, token, dataset_id, ctx))
		return
	try:
		yield url
	except Exception as e:
		if url not in str(e):
			raise
		raise RuntimeError(str(e).replace(url, STREAMED)) from None


def stored_cog(client, dataset_id: int) -> Cog:
	"""The dataset's COG row; local_cog fetches the file."""
	rows = client.table(settings.cogs_table).select('*').eq('dataset_id', dataset_id).execute().data
	if not rows:
		raise ValueError('dataset has no COG; run the cog stage first')
	return Cog(**rows[0])


def ortho_sha256(client, dataset_id: int) -> str:
	"""The hash of the dataset's ortho: what an audit run judged (its inputs)."""
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
	# Page by id through the (dataset_id, id) index. Ordered by id with only the dataset index,
	# Postgres walked the primary key through other datasets' tiles.
	pages = iter_pages_by_id(
		lambda select: client.table(settings.tile_embeddings_table).select(select).eq('dataset_id', dataset_id),
		'id,pixel_x0,pixel_y0,pixel_x1,pixel_y1,geometry',
	)
	return [{**row, 'geometry': read_geometry(row['geometry'])} for page in pages for row in page]
