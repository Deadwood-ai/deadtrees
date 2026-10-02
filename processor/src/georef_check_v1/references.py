"""Reference imagery for the georeferencing check, on the drone image's grid.

Providers come from the registry in providers.py. XYZ tiles covering the grid's
EPSG:3857 bounds are mosaicked at the coarsest zoom that still resolves the grid
(capped by a tile budget) and resampled onto the grid; WMS and ArcGIS export
services render the grid extent directly. Dated Esri Wayback captures are added
per site. Keyed providers are used only when their key is set.
"""

from __future__ import annotations

import io
import math
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, timezone

import numpy as np
import requests
from PIL import Image

from shared.settings import settings

from .evidence import Grid
from .providers import ESRI, REGISTRY, Provider

WORLD = 40075016.68557849
TILE_BUDGET = 45
USER_AGENT = 'DeadTrees-georeferencing-check/1.0 (+https://deadtrees.earth)'
WAYBACK_CONFIG = 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json'
WAYBACK_TILES = (
	'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{release}/{z}/{y}/{x}'
)


@dataclass
class Reference:
	provider: str  # registry name, or wayback-<release>
	group: str  # evidence group (providers.py)
	image: np.ndarray  # (H, W, 3) uint8 on the drone grid
	zoom: int | None = None  # XYZ zoom used; None for WMS/ArcGIS exports
	capture_date: str | None = None  # Wayback: the imagery's acquisition date
	viewer: dict | None = None  # keyless service description the audit viewer can show


def _session() -> requests.Session:
	s = requests.Session()
	s.headers['User-Agent'] = USER_AGENT
	return s


def _zoom_and_tiles(grid: Grid, max_zoom: int):
	left, bottom, right, top = grid.bounds
	half = WORLD / 2
	z = max(0, min(max_zoom, math.floor(math.log2(WORLD / (256 * grid.res)))))
	while True:
		step = WORLD / 2**z
		x0, x1 = math.floor((left + half) / step), math.floor((right + half) / step)
		y0, y1 = math.floor((half - top) / step), math.floor((half - bottom) / step)
		if (x1 - x0 + 1) * (y1 - y0 + 1) <= TILE_BUDGET or z == 0:
			return z, step, x0, x1, y0, y1
		z -= 1


def mosaic(grid: Grid, url_for, max_zoom: int = 19, session: requests.Session | None = None):
	"""Fetch the tiles covering `grid` (url_for(z, x, y) -> (url, params)) and
	resample them onto it. Returns (image, zoom); raises on any failed tile."""
	session = session or _session()
	z, step, x0, x1, y0, y1 = _zoom_and_tiles(grid, max_zoom)

	def fetch(xy):
		x, y = xy
		url, params = url_for(z, x, y)
		r = session.get(url, params=params, timeout=40)
		if r.status_code != 200:
			# never include the URL: it can carry an API key
			raise RuntimeError(f'tile HTTP {r.status_code}')
		return x, y, Image.open(io.BytesIO(r.content)).convert('RGB').resize((256, 256))

	canvas = Image.new('RGB', ((x1 - x0 + 1) * 256, (y1 - y0 + 1) * 256))
	with ThreadPoolExecutor(max_workers=4) as pool:
		for x, y, tile in pool.map(fetch, [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]):
			canvas.paste(tile, ((x - x0) * 256, (y - y0) * 256))
	left, bottom, right, top = grid.bounds
	half = WORLD / 2
	box = (
		(left + half) / step * 256 - x0 * 256,
		(half - top) / step * 256 - y0 * 256,
		(right + half) / step * 256 - x0 * 256,
		(half - bottom) / step * 256 - y0 * 256,
	)
	image = canvas.transform((grid.width, grid.height), Image.Transform.EXTENT, box, Image.Resampling.BICUBIC)
	return np.asarray(image), z


def _blank(image: np.ndarray) -> bool:
	return float(np.max(image.reshape(-1, 3).std(axis=0))) < 2


def wayback_captures(lon: float, lat: float, zoom: int, session: requests.Session) -> list[dict]:
	"""The capture date at the point in the last Wayback release of every year.

	Walking every release through the tilemap service took ~100 s per dataset on
	the slow archive host; one metadata query per year, in parallel, takes a few
	seconds and still finds each distinct capture."""
	catalog = session.get(WAYBACK_CONFIG, timeout=30).json()
	yearly: dict[str, dict] = {}
	for release, item in catalog.items():
		released = item['itemTitle'].split('Wayback ')[-1].rstrip(')')
		if released >= yearly.get(released[:4], {}).get('released', ''):
			yearly[released[:4]] = {'release': int(release), 'released': released, 'metadata': item['metadataLayerUrl']}
	point = f'{{"spatialReference":{{"wkid":4326}},"x":{lon},"y":{lat}}}'

	def capture(item):
		meta = session.get(
			item['metadata'] + f'/{23 - zoom}/query',
			params={
				'f': 'json',
				'where': '1=1',
				'outFields': 'SRC_DATE2',
				'geometry': point,
				'geometryType': 'esriGeometryPoint',
				'spatialRel': 'esriSpatialRelIntersects',
				'returnGeometry': 'false',
			},
			timeout=30,
		).json()
		ms = ((meta.get('features') or [{}])[0].get('attributes') or {}).get('SRC_DATE2')
		captured = datetime.fromtimestamp(ms / 1000, timezone.utc).date().isoformat() if ms else None
		return {'release': item['release'], 'capture_date': captured}

	with ThreadPoolExecutor(max_workers=6) as pool:
		captures = list(pool.map(capture, sorted(yearly.values(), key=lambda i: i['released'], reverse=True)))
	return captures


def pick_wayback(captures: list[dict], flight: date | None, n: int = 2) -> list[dict]:
	"""Older dated captures than the current imagery (which Esri World Imagery
	already shows): the one closest to the flight date, then the oldest."""
	dated = {}
	for c in captures:
		if c['capture_date'] and c['capture_date'] not in dated:
			dated[c['capture_date']] = c
	older = sorted(dated.values(), key=lambda c: c['capture_date'])[:-1]
	chosen = []
	if flight and older:
		chosen.append(min(older, key=lambda c: abs((date.fromisoformat(c['capture_date']) - flight).days)))
	for c in older:
		if len(chosen) >= n:
			break
		if c not in chosen:
			chosen.append(c)
	return chosen


def _render(grid: Grid, provider: Provider, session: requests.Session) -> tuple[np.ndarray, int | None]:
	"""The provider's imagery on `grid`, and the XYZ zoom used (None for renders)."""
	key = getattr(settings, provider.key_setting) if provider.key_setting else None
	params = {provider.key_param: key} if key else None
	if provider.kind == 'xyz':

		def url_for(z, x, y):
			return provider.url.replace('{-y}', str(2**z - 1 - y)).format(z=z, x=x, y=y), params

		return mosaic(grid, url_for, provider.max_zoom, session)
	left, bottom, right, top = grid.bounds
	if provider.kind == 'wms':
		crs = 'CRS' if provider.wms_version == '1.3.0' else 'SRS'
		bbox = f'{left},{bottom},{right},{top}'
		if provider.wms_crs == 'EPSG:4326':
			# the grid's lon/lat box; at a few hundred metres the Mercator/lat-lon
			# difference inside it is far below a pixel, so a resize suffices.
			# WMS 1.3.0 orders EPSG:4326 as lat,lon
			lon, lat = grid.lonlat(np.array([[0.0, grid.height - 1.0], [grid.width - 1.0, 0.0]]))
			w, s, e, n = lon[0], lat[0], lon[1], lat[1]
			bbox = f'{s},{w},{n},{e}' if provider.wms_version == '1.3.0' else f'{w},{s},{e},{n}'
		query = {
			'SERVICE': 'WMS',
			'REQUEST': 'GetMap',
			'VERSION': provider.wms_version,
			'LAYERS': provider.wms_layers,
			'STYLES': '',
			crs: provider.wms_crs,
			'BBOX': bbox,
			'WIDTH': grid.width,
			'HEIGHT': grid.height,
			'FORMAT': provider.image_format,
		}
	elif provider.kind == 'arcgis_export':
		query = {
			'bbox': f'{left},{bottom},{right},{top}',
			'bboxSR': 3857,
			'imageSR': 3857,
			'size': f'{grid.width},{grid.height}',
			'format': 'jpg',
			'f': 'image',
		}
	else:
		raise ValueError(f'unknown provider kind {provider.kind}')
	r = session.get(provider.url, params={**query, **(params or {})}, timeout=60)
	if r.status_code != 200 or not r.headers.get('content-type', '').startswith('image/'):
		# never include the URL: it can carry an API key
		raise RuntimeError(f'render HTTP {r.status_code} {r.headers.get("content-type", "")}'.strip())
	image = Image.open(io.BytesIO(r.content)).convert('RGB')
	if image.size != (grid.width, grid.height):
		image = image.resize((grid.width, grid.height), Image.Resampling.BICUBIC)
	return np.asarray(image), None


def _viewer(provider: Provider) -> dict | None:
	"""How the audit viewer can show a keyless provider (keys never reach the browser)."""
	if provider.key_setting or provider.kind == 'arcgis_export' or provider.wms_crs != 'EPSG:3857':
		return None
	if provider.kind == 'xyz':
		if '{-y}' in provider.url:
			return None
		return {'kind': 'xyz', 'url': provider.url, 'max_zoom': provider.max_zoom, 'attribution': provider.attribution}
	return {
		'kind': 'wms',
		'url': provider.url,
		'layers': provider.wms_layers,
		'version': provider.wms_version,
		'format': provider.image_format,
		'attribution': provider.attribution,
	}


def applicable(lon: float, lat: float) -> list[Provider]:
	"""Registry providers for a site: covering it, and with their key set."""
	return [p for p in REGISTRY if p.covers(lon, lat) and (not p.key_setting or getattr(settings, p.key_setting))]


def fetch_references(
	grid: Grid, centre_lonlat: tuple[float, float], flight: date | None
) -> tuple[list[Reference], dict]:
	"""All available references, plus {provider: error} for the ones that failed."""
	session = _session()
	refs, errors = [], {}

	def add(provider: Provider, capture_date=None):
		try:
			image, z = _render(grid, provider, session)
		except Exception as e:  # one provider failing must not fail the check
			errors[provider.name] = type(e).__name__ + (f': {e}' if isinstance(e, RuntimeError) else '')
			return
		if _blank(image):
			errors[provider.name] = 'blank imagery'
			return
		refs.append(Reference(provider.name, provider.group, image, z, capture_date, _viewer(provider)))

	providers = applicable(*centre_lonlat)
	with ThreadPoolExecutor(max_workers=4) as pool:
		list(pool.map(add, providers))
	try:
		zoom = _zoom_and_tiles(grid, 19)[0]
		for c in pick_wayback(wayback_captures(*centre_lonlat, zoom, session), flight):
			add(
				Provider(
					f'wayback-{c["release"]}',
					ESRI.group,
					'xyz',
					WAYBACK_TILES.replace('{release}', str(c['release'])),
					attribution=ESRI.attribution,
				),
				c['capture_date'],
			)
	except Exception as e:
		errors['wayback'] = type(e).__name__
	order = {p.name: i for i, p in enumerate(providers)}
	refs.sort(key=lambda r: order.get(r.provider, len(order)))
	return refs, errors
