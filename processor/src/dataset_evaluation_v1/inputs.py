"""What the dataset evaluation looks at, read straight from the COG at run time.

One read at most `overview_px` on the long side through the COG overviews gives the
overview, its valid-data mask, per-band statistics and the perceptual hash. Four
native-resolution crops spread over the valid data (inside the AOI when there is
one) show sharpness and artifacts the overview cannot. The crops sit wholly inside
the data, at the centres of a seeded k-means split of it, so they spread over the
dataset without hugging its distorted edges, and a rerun judges the same crops.
"""

from dataclasses import dataclass, field

import numpy as np
import rasterio
from pyproj import Geod, Transformer
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.warp import transform_geom
from rasterio.windows import Window
from scipy import ndimage
from shapely.geometry import Polygon, box, mapping, shape

OVERVIEW_PX = 2048
CROP_PX = 1024
CROP_COUNT = 4
CROP_PICKER = 'kmeans-inside-v1'
# The crop centres are found on a sample of the eligible overview pixels.
MAX_CANDIDATES = 4000
KMEANS_ROUNDS = 10
# Footprint padding without a mask: solid white or black (the thresholds of utils/nodata.py)
WHITE_FILL_MIN = 250
BLACK_FILL_MAX = 1
GEOD = Geod(ellps='WGS84')


@dataclass
class Crop:
	image: np.ndarray  # H x W x 3 uint8 at native resolution
	window: tuple[int, int, int, int]  # col_off, row_off, width, height in COG pixels
	footprint: Polygon  # EPSG:4326
	mpp: float  # ground metres per pixel


@dataclass
class Inputs:
	overview: np.ndarray  # H x W x 3 uint8
	valid: np.ndarray  # H x W bool: real data
	aoi: np.ndarray | None  # H x W bool inside the AOI, None without an AOI
	bands: np.ndarray  # C x H x W, every COG band at overview size
	overview_mpp: float
	native_mpp: float
	size: tuple[int, int]  # full-resolution width, height
	footprint: Polygon  # EPSG:4326 bounds of the valid data
	crops: list[Crop] = field(default_factory=list)
	settings: dict = field(default_factory=dict)


def ground_mpp(src, col: float, row: float, step: float = 1.0) -> float:
	"""Ground metres per `step` COG pixels at (col, row), so EPSG:3857 scale is undone."""
	to_wgs = Transformer.from_crs(src.crs, 4326, always_xy=True)
	a = to_wgs.transform(*(src.transform @ (col, row)))
	b = to_wgs.transform(*(src.transform @ (col + step, row)))
	return abs(GEOD.inv(*a, *b)[2]) / step


def window_footprint(src, window: Window) -> Polygon:
	left, bottom, right, top = rasterio.windows.bounds(window, src.transform)
	return shape(transform_geom(src.crs, 'EPSG:4326', mapping(box(left, bottom, right, top))))


def rgb_of(bands: np.ndarray) -> np.ndarray:
	"""The first three bands as an image; a single band is shown as gray."""
	rgb = bands[:3] if bands.shape[0] >= 3 else np.repeat(bands[:1], 3, axis=0)
	return np.ascontiguousarray(rgb.transpose(1, 2, 0)).astype(np.uint8)


def padding(rgb: np.ndarray, valid: np.ndarray) -> np.ndarray:
	"""Solid white or black pixels connected to the image edge or to masked no-data:
	footprint padding of orthos without a mask. White or black inside the data (snow,
	roofs, shadow) does not touch the padding and stays valid."""
	fill = np.all(rgb >= WHITE_FILL_MIN, axis=2) | np.all(rgb <= BLACK_FILL_MAX, axis=2)
	seed = ~valid
	seed[[0, -1], :] = True
	seed[:, [0, -1]] = True
	labels, _ = ndimage.label(fill)
	touching = np.unique(labels[seed & fill])
	return np.isin(labels, touching[touching != 0])


def inside(mask: np.ndarray, half: int) -> np.ndarray:
	"""Pixels whose (2 * half + 1) square lies wholly inside `mask`."""
	if half <= 0:
		return mask
	h, w = mask.shape
	total = np.zeros((h + 1, w + 1), np.int32)
	total[1:, 1:] = mask.astype(np.int32).cumsum(0).cumsum(1)
	out = np.zeros_like(mask)
	k = 2 * half + 1
	if h < k or w < k:
		return out
	window = total[k:, k:] - total[:-k, k:] - total[k:, :-k] + total[:-k, :-k]
	out[half : h - half, half : w - half] = window == k * k
	return out


def spread_points(candidates: np.ndarray, count: int, seed: int) -> list[tuple[float, float]]:
	"""`count` candidate (x, y) points spread over the candidates: seeded k-means++
	centres refined by a few k-means rounds, each snapped to its nearest candidate."""
	rng = np.random.default_rng(seed)
	if len(candidates) > MAX_CANDIDATES:
		candidates = candidates[rng.choice(len(candidates), MAX_CANDIDATES, replace=False)]
	count = min(count, len(candidates))
	centres = [candidates[rng.integers(len(candidates))]]
	while len(centres) < count:
		d2 = np.min([((candidates - c) ** 2).sum(1) for c in centres], axis=0)
		centres.append(candidates[rng.choice(len(candidates), p=d2 / d2.sum())] if d2.sum() else candidates[0])
	centres = np.array(centres, float)
	for _ in range(KMEANS_ROUNDS):
		nearest = np.argmin(((candidates[:, None] - centres[None]) ** 2).sum(2), axis=1)
		centres = np.array(
			[candidates[nearest == k].mean(0) if (nearest == k).any() else centres[k] for k in range(count)]
		)
	picked = [int(np.argmin(((candidates - c) ** 2).sum(1))) for c in centres]
	# Left to right, top to bottom, so crop numbers read like the overview.
	return sorted((tuple(candidates[i]) for i in dict.fromkeys(picked)), key=lambda p: (round(p[1], -2), p[0]))


def read_inputs(
	cog: str,
	aoi_4326: dict | None = None,
	seed: int = 0,
	overview_px: int = OVERVIEW_PX,
	crop_px: int = CROP_PX,
	crop_count: int = CROP_COUNT,
) -> Inputs:
	"""Read the overview and crops of the COG at `cog` (path or URL)."""
	env = dict(
		GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_TIMEOUT='60', GDAL_HTTP_MAX_RETRY='2', GDAL_CACHEMAX=128
	)
	with rasterio.Env(**env), rasterio.open(cog) as src:
		if not src.crs:
			raise ValueError('The COG has no CRS')
		factor = min(1.0, overview_px / max(src.width, src.height))
		w, h = max(1, round(src.width * factor)), max(1, round(src.height * factor))
		bands = src.read(out_shape=(src.count, h, w), resampling=Resampling.bilinear)
		if bands.dtype != np.uint8:
			raise ValueError(f'Expected an 8-bit COG, got {bands.dtype}')
		overview = rgb_of(bands)
		valid = src.dataset_mask(out_shape=(h, w), resampling=Resampling.nearest) > 0
		valid &= ~padding(overview, valid)
		if not valid.any():
			raise ValueError('The COG overview has no valid pixels')
		scale = src.width / w
		aoi = None
		if aoi_4326 and aoi_4326.get('type') == 'Feature':
			aoi_4326 = aoi_4326['geometry']  # older AOI rows hold a Feature
		if aoi_4326:
			native_aoi = transform_geom('EPSG:4326', src.crs, aoi_4326)
			overview_transform = src.transform @ rasterio.Affine.scale(src.width / w, src.height / h)
			aoi = rasterize([(native_aoi, 1)], out_shape=(h, w), transform=overview_transform, dtype='uint8') > 0
			if not (aoi & valid).any():
				aoi = None  # an AOI off the data says nothing about where to look
		rows, cols = np.nonzero(valid)
		valid_window = Window(
			cols.min() * scale,
			rows.min() * scale,
			(cols.max() + 1 - cols.min()) * scale,
			(rows.max() + 1 - rows.min()) * scale,
		)
		native_mpp = ground_mpp(src, src.width / 2, src.height / 2)
		inputs = Inputs(
			overview=overview,
			valid=valid,
			aoi=aoi,
			bands=bands,
			overview_mpp=native_mpp * scale,
			native_mpp=native_mpp,
			size=(src.width, src.height),
			footprint=window_footprint(src, valid_window),
			settings={
				'overview_px': overview_px,
				'crop_px': crop_px,
				'crop_count': crop_count,
				'crop_picker': CROP_PICKER,
				'seed': seed,
			},
		)
		where = valid & aoi if aoi is not None else valid
		cw, ch = min(crop_px, src.width), min(crop_px, src.height)
		# Prefer centres whose whole crop is real data; small or ragged data falls back.
		half = int(np.ceil(max(cw, ch) / 2 / scale))
		eligible = where & inside(valid, half)
		ys, xs = np.nonzero(eligible if eligible.any() else where)
		for x, y in spread_points(np.column_stack((xs, ys)).astype(float), crop_count, seed):
			col = int(np.clip((x + 0.5) * scale - cw / 2, 0, src.width - cw))
			row = int(np.clip((y + 0.5) * scale - ch / 2, 0, src.height - ch))
			window = Window(col, row, cw, ch)
			data = src.read(window=window)
			inputs.crops.append(Crop(rgb_of(data), (col, row, cw, ch), window_footprint(src, window), native_mpp))
	return inputs
