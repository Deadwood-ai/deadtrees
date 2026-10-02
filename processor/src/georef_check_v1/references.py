"""Reference imagery for the georeferencing check, on the drone image's grid.

Each provider's XYZ tiles covering the grid's EPSG:3857 bounds are mosaicked at
the coarsest zoom that still resolves the grid (capped by a tile budget) and
resampled onto the grid. Esri World Imagery and its dated Wayback captures need
no key; Google (Map Tiles API), MapTiler and Mapbox are used when a key is set.
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

WORLD = 40075016.68557849
TILE_BUDGET = 45
USER_AGENT = 'DeadTrees-georeferencing-check/1.0 (+https://deadtrees.earth)'
ESRI_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
WAYBACK_CONFIG = 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json'
WAYBACK_TILEMAP = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap'
WAYBACK_TILES = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{release}/{z}/{y}/{x}'


@dataclass
class Reference:
	provider: str  # esri, wayback-<release>, google, maptiler, mapbox
	image: np.ndarray  # (H, W, 3) uint8 on the drone grid
	zoom: int
	capture_date: str | None = None  # Wayback: the imagery's acquisition date
	tile_url: str | None = None  # keyless XYZ template the audit viewer can show


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


def _tile_xy(lon: float, lat: float, z: int) -> tuple[int, int]:
	y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * 2**z
	return int((lon + 180) / 360 * 2**z), int(y)


def wayback_captures(lon: float, lat: float, zoom: int, session: requests.Session, limit: int = 30) -> list[dict]:
	"""Distinct Wayback releases with imagery at the point, newest first, each
	with the imagery's capture date from the release's metadata layer."""
	catalog = session.get(WAYBACK_CONFIG, timeout=30).json()
	releases = sorted(
		({'release': int(k), **v} for k, v in catalog.items()),
		key=lambda r: r['itemTitle'].split('Wayback ')[-1].rstrip(')'),
		reverse=True,
	)
	index = {r['release']: i for i, r in enumerate(releases)}
	x, y = _tile_xy(lon, lat, 12)
	captures, release = [], releases[0]['release']
	while release is not None and len(captures) < limit:
		tilemap = session.get(f'{WAYBACK_TILEMAP}/{release}/12/{y}/{x}', timeout=30).json()
		if not (tilemap.get('data') or [0])[0]:
			break
		selected = (tilemap.get('select') or [None])[0]
		actual = int(selected) if selected else release
		if actual not in index:
			break
		item = releases[index[actual]]
		meta = session.get(
			item['metadataLayerUrl'] + f'/{23 - zoom}/query',
			params={
				'f': 'json',
				'where': '1=1',
				'outFields': 'SRC_DATE2',
				'geometry': f'{{"spatialReference":{{"wkid":4326}},"x":{lon},"y":{lat}}}',
				'geometryType': 'esriGeometryPoint',
				'spatialRel': 'esriSpatialRelIntersects',
				'returnGeometry': 'false',
			},
			timeout=30,
		).json()
		ms = ((meta.get('features') or [{}])[0].get('attributes') or {}).get('SRC_DATE2')
		captured = datetime.fromtimestamp(ms / 1000, timezone.utc).date().isoformat() if ms else None
		captures.append({'release': actual, 'capture_date': captured})
		nxt = index[actual] + 1
		release = releases[nxt]['release'] if nxt < len(releases) else None
	return captures


def pick_wayback(captures: list[dict], flight: date | None, n: int = 2) -> list[dict]:
	"""The capture closest to the flight date plus the newest other dated capture."""
	dated = {}
	for c in captures:
		if c['capture_date'] and c['capture_date'] not in dated:
			dated[c['capture_date']] = c
	if not dated:
		return []
	ordered = sorted(dated.values(), key=lambda c: c['capture_date'], reverse=True)
	chosen = []
	if flight:
		chosen.append(min(ordered, key=lambda c: abs((date.fromisoformat(c['capture_date']) - flight).days)))
	for c in ordered:
		if len(chosen) >= n:
			break
		if c not in chosen:
			chosen.append(c)
	return chosen


def _google_session(session: requests.Session) -> str:
	r = session.post(
		'https://tile.googleapis.com/v1/createSession',
		params={'key': settings.GOOGLE_MAP_TILES_API_KEY},
		json={'mapType': 'satellite', 'language': 'en-US', 'region': 'US'},
		timeout=30,
	)
	if r.status_code != 200:
		raise RuntimeError(f'Google session HTTP {r.status_code}')
	return r.json()['session']


def fetch_references(grid: Grid, centre_lonlat: tuple[float, float], flight: date | None) -> tuple[list[Reference], dict]:
	"""All available references, plus {provider: error} for the ones that failed."""
	session = _session()
	refs, errors = [], {}

	def add(provider, url_for, max_zoom=19, capture_date=None, tile_url=None):
		try:
			image, z = mosaic(grid, url_for, max_zoom, session)
		except Exception as e:  # one provider failing must not fail the check
			errors[provider] = type(e).__name__ + (f': {e}' if isinstance(e, RuntimeError) else '')
			return
		if _blank(image):
			errors[provider] = 'blank imagery'
			return
		refs.append(Reference(provider, image, z, capture_date, tile_url))

	add('esri', lambda z, x, y: (ESRI_TILES.format(z=z, x=x, y=y), None), 18, tile_url=ESRI_TILES)
	try:
		zoom = _zoom_and_tiles(grid, 19)[0]
		for c in pick_wayback(wayback_captures(*centre_lonlat, zoom, session), flight):
			template = WAYBACK_TILES.replace('{release}', str(c['release']))
			add(
				f'wayback-{c["release"]}',
				lambda z, x, y, t=template: (t.format(z=z, x=x, y=y), None),
				19,
				c['capture_date'],
				template,
			)
	except Exception as e:
		errors['wayback'] = type(e).__name__
	if settings.GOOGLE_MAP_TILES_API_KEY:
		try:
			token = _google_session(session)
			add(
				'google',
				lambda z, x, y: (
					f'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}',
					{'session': token, 'key': settings.GOOGLE_MAP_TILES_API_KEY},
				),
				20,
			)
		except Exception as e:
			errors['google'] = type(e).__name__ + (f': {e}' if isinstance(e, RuntimeError) else '')
	if settings.MAPTILER_API_KEY:
		add(
			'maptiler',
			lambda z, x, y: (
				f'https://api.maptiler.com/maps/satellite-v4/256/{z}/{x}/{y}.jpg',
				{'key': settings.MAPTILER_API_KEY},
			),
			20,
		)
	if settings.MAPBOX_ACCESS_TOKEN:
		add(
			'mapbox',
			lambda z, x, y: (
				f'https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}.jpg90',
				{'access_token': settings.MAPBOX_ACCESS_TOKEN},
			),
			20,
		)
	return refs, errors
