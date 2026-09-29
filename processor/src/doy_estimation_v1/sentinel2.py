"""Sentinel-2 weekly composites for an ortho from the scaled-pipeline block cubes.

The Sentinel pipeline (separate Supabase project + S3 bucket) downloads S2 in
30 km UTM blocks: `block_{epsg}_{minx}_{miny}`, aligned to multiples of
30 000 m in the northern-hemisphere zone code 326xx (southern blocks carry
negative northings), stored as zarr v3 at `<bucket>/<prefix>/<block>.zarr`:
`sentle(time, band, y, x)` uint16 DN, 0 = nodata (clouds/snow masked), weekly
composites (timestamps are window centres), x/y the upper-left cell corners.

Block lookup: candidate names for the site's UTM zone and its neighbours
(the grid assigns zone-edge sites to the neighbouring zone), then
- with SENTINEL_BLOCKS_SUPABASE_URL/KEY set: the `chunks` table, status done;
- without: the block's zarr.json on S3 (recorded as block_status "unverified").
"""

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import rasterio
import requests
import shapely.geometry
from pyproj import Transformer
from rasterio.features import rasterize
from shapely.ops import transform as shapely_transform

from shared.settings import settings

from .features import S2_BANDS, S2Cube, S2Grid, flight_year_window

BLOCK_SIZE_M = 30_000
MARGIN_M = 20


@dataclass
class S2Lookup:
	"""Why an ortho got (or did not get) an S2 cube; stored in the estimate."""

	status: str  # ok | no_block | block_not_done | outside_archive | no_credentials | error
	block: str | None = None
	block_status: str | None = None
	cube_start: str | None = None
	cube_end: str | None = None
	weeks_in_window: int = 0
	detail: dict = field(default_factory=dict)

	def as_dict(self) -> dict:
		return {
			'status': self.status,
			'block': self.block,
			'block_status': self.block_status,
			'cube_start': self.cube_start,
			'cube_end': self.cube_end,
			'weeks_in_window': self.weeks_in_window,
			**self.detail,
		}


def utm_zone(lon: float) -> int:
	return min(max(int(math.floor((lon + 180) / 6)) + 1, 1), 60)


def candidate_blocks(lon: float, lat: float) -> list[tuple[str, int]]:
	"""(block_name, epsg) for the site's zone first, then both neighbours."""
	zone = utm_zone(lon)
	out = []
	for z in (zone, zone - 1, zone + 1):
		if not 1 <= z <= 60:
			continue
		epsg = 32600 + z
		e, n = Transformer.from_crs(4326, epsg, always_xy=True).transform(lon, lat)
		minx = int(math.floor(e / BLOCK_SIZE_M) * BLOCK_SIZE_M)
		miny = int(math.floor(n / BLOCK_SIZE_M) * BLOCK_SIZE_M)
		out.append((f'block_{epsg}_{minx}_{miny}', epsg))
	return out


def _chunk_status(names: list[str]) -> dict[str, str] | None:
	"""block_name -> status from the Sentinel pipeline's chunks table, or None
	when the blocks database is not configured."""
	if not settings.SENTINEL_BLOCKS_SUPABASE_URL or not settings.SENTINEL_BLOCKS_SUPABASE_KEY:
		return None
	key = settings.SENTINEL_BLOCKS_SUPABASE_KEY
	r = requests.get(
		f'{settings.SENTINEL_BLOCKS_SUPABASE_URL.rstrip("/")}/rest/v1/chunks',
		params={'select': 'block_name,status', 'block_name': f'in.({",".join(names)})'},
		headers={'apikey': key, 'Authorization': f'Bearer {key}'},
		timeout=30,
	)
	r.raise_for_status()
	return {row['block_name']: row['status'] for row in r.json()}


def _s3fs():
	import s3fs

	return s3fs.S3FileSystem(
		key=settings.SENTINEL2_S3_ACCESS_KEY_ID,
		secret=settings.SENTINEL2_S3_SECRET_ACCESS_KEY,
		client_kwargs={'endpoint_url': settings.SENTINEL2_S3_ENDPOINT, 'region_name': settings.SENTINEL2_S3_REGION},
		config_kwargs={'connect_timeout': 30, 'read_timeout': 120, 'retries': {'max_attempts': 5}},
	)


def _block_root(block: str) -> str:
	return f'{settings.SENTINEL2_S3_BUCKET}/{settings.SENTINEL2_S3_PREFIX.strip("/")}/{block}.zarr'


def s2_configured() -> bool:
	return bool(settings.SENTINEL2_S3_ACCESS_KEY_ID and settings.SENTINEL2_S3_SECRET_ACCESS_KEY)


def _site_geometry(aoi_4326: dict | None, bbox_4326: tuple) -> shapely.geometry.base.BaseGeometry:
	if aoi_4326 is not None:
		return shapely.geometry.shape(aoi_4326)
	return shapely.geometry.box(*bbox_4326)


def fetch_cube(aoi_4326: dict | None, bbox_4326: tuple, year: int) -> tuple[S2Cube | None, S2Lookup]:
	"""Crop the covering block cube to the site (AOI, else the ortho bbox) and
	the flight-year window. Any failure degrades to (None, reason)."""
	if not s2_configured():
		return None, S2Lookup('no_credentials')
	site = _site_geometry(aoi_4326, bbox_4326)
	c = site.centroid
	candidates = candidate_blocks(c.x, c.y)
	names = [n for n, _ in candidates]
	try:
		statuses = _chunk_status(names)
	except Exception as e:  # the blocks DB being down must not fail the stage
		return None, S2Lookup('error', detail={'error': f'chunks lookup: {e}'[:300]})

	fs = _s3fs()
	for name, epsg in candidates:
		to_utm = Transformer.from_crs(4326, epsg, always_xy=True).transform
		site_utm = shapely_transform(to_utm, site)
		minx, miny = (int(v) for v in name.split('_')[2:4])
		block_box = shapely.geometry.box(minx, miny, minx + BLOCK_SIZE_M, miny + BLOCK_SIZE_M)
		if not block_box.contains(site_utm.centroid):
			continue
		if statuses is not None:
			status = statuses.get(name)
			if status != 'done':
				return None, S2Lookup('no_block' if status is None else 'block_not_done', block=name, block_status=status)
		elif not fs.exists(f'{_block_root(name)}/zarr.json'):
			return None, S2Lookup('no_block', block=name, block_status='not_on_s3')
		try:
			cube, info = _crop(fs, name, epsg, site_utm.intersection(block_box), year, has_aoi=aoi_4326 is not None)
		except Exception as e:
			return None, S2Lookup('error', block=name, detail={'error': repr(e)[:300]})
		info.block_status = 'done' if statuses is not None else 'unverified'
		return cube, info
	return None, S2Lookup('no_block', detail={'candidates': names})


def _crop(fs, name: str, epsg: int, site_utm, year: int, has_aoi: bool) -> tuple[S2Cube | None, S2Lookup]:
	import xarray as xr

	ds = xr.open_zarr(fs.get_mapper(_block_root(name)), consolidated=False)
	t_all = pd.DatetimeIndex(ds.time.values)
	info = S2Lookup('ok', block=name, cube_start=str(t_all.min().date()), cube_end=str(t_all.max().date()))
	start, end = flight_year_window(year)
	tsel = np.nonzero((t_all >= start) & (t_all < end))[0]
	info.weeks_in_window = int(len(tsel))
	if not len(tsel):
		info.status = 'outside_archive'
		return None, info

	x0, y0, x1, y1 = site_utm.buffer(MARGIN_M).bounds
	xs, ys = ds.x.values.astype(float), ds.y.values.astype(float)
	# cell [x, x+10) x (y-10, y]: keep every cell touching the site
	xi = np.nonzero((xs + 10 > x0) & (xs < x1))[0]
	yi = np.nonzero((ys > y0) & (ys - 10 < y1))[0]
	if not len(xi) or not len(yi):
		info.status = 'no_block'
		return None, info
	window = (
		ds['sentle']
		.sel(band=S2_BANDS)
		.isel(time=tsel, x=slice(xi.min(), xi.max() + 1), y=slice(yi.min(), yi.max() + 1))
		.load()
	)
	order = np.argsort(window.time.values)
	values = window.values[order].astype(np.float32)
	values[values == 0] = np.nan
	crs = rasterio.crs.CRS.from_epsg(epsg)
	grid = S2Grid(crs=crs, x=window.x.values.astype(float), y=window.y.values.astype(float))
	# without an AOI the S2 site is the ortho's coverage (features.s2_series
	# falls back to it), as it was for the research cubes without labels
	aoi = np.zeros(grid.shape, bool)
	if has_aoi:
		aoi = rasterize(
			[shapely.geometry.mapping(site_utm)], out_shape=grid.shape, transform=grid.transform, fill=0, default_value=1, dtype=np.uint8
		).astype(bool)
	cube = S2Cube(grid=grid, time=window.time.values[order].astype('datetime64[ns]'), values=values, aoi=aoi)
	return cube, info
