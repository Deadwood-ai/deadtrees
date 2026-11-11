"""What the dataset evaluation looks at, read straight from the COG at run time.

One read at most `overview_px` on the long side through the COG overviews gives the
overview, its valid-data mask, per-band statistics and the perceptual hash. Four
crops spread over the data show sharpness and
artifacts the overview cannot. They are CLIP tiles (v2_tile_embeddings: 51.2 m
windows on the 10 cm UTM grid of the embedding stage), rendered at 5 cm or native
when coarser, so the prediction quality check judges the same crops. A dataset
without tiles gets native-resolution windows instead. Either way the crops are the
centres of a seeded k-means split of the candidates, so they spread over the
dataset without hugging its distorted edges, and a rerun judges the same crops.
"""

from dataclasses import dataclass, field

import numpy as np
import rasterio
from pyproj import Geod, Transformer
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.warp import transform_geom
from rasterio.windows import Window
from scipy import ndimage
from shapely.geometry import Polygon, box, mapping, shape

from ..utils.crs import get_utm_string_from_latlon

OVERVIEW_PX = 2048
CROP_PX = 1024
CROP_COUNT = 4
CROP_PICKER = 'kmeans-inside-v1'  # native windows, for datasets without CLIP tiles
GRID_PICKER = 'clip-grid-kmeans-v1'
GRID_MPP = 0.10  # the CLIP tile grid of the embedding stage
CROP_MPP = 0.05  # grid crops render at 5 cm, or native when coarser
# The crop centres are found on a sample of the eligible overview pixels.
MAX_CANDIDATES = 4000
KMEANS_ROUNDS = 10
# Below this share of valid overview pixels the COG holds no usable image (empty_cog rule).
MIN_VALID_SHARE = 0.005
# Footprint padding without a mask: solid white or black (the thresholds of utils/nodata.py)
WHITE_FILL_MIN = 250
BLACK_FILL_MAX = 1
GEOD = Geod(ellps='WGS84')


@dataclass
class Tile:
	"""A CLIP tile: its window on the 10 cm grid and the centre of its footprint."""

	window: tuple[int, int, int, int]  # pixel_x0, pixel_y0, pixel_x1, pixel_y1
	centre: tuple[float, float]  # lon, lat


@dataclass
class Crop:
	image: np.ndarray  # H x W x 3 uint8
	footprint: Polygon  # EPSG:4326
	mpp: float  # ground metres per pixel of the image
	picker: str
	grid_window: tuple[int, int, int, int] | None = None  # on the 10 cm grid; None off the grid
	cog_window: tuple[int, int, int, int] | None = None  # col_off, row_off, width, height for native crops


@dataclass
class Inputs:
	overview: np.ndarray  # H x W x 3 uint8
	valid: np.ndarray  # H x W bool: real data
	bands: np.ndarray  # C x H x W, every COG band at overview size
	overview_mpp: float
	native_mpp: float
	size: tuple[int, int]  # full-resolution width, height
	footprint: Polygon  # EPSG:4326 bounds of the valid data
	crops: list[Crop] = field(default_factory=list)
	settings: dict = field(default_factory=dict)

	@property
	def valid_share(self) -> float:
		return float(self.valid.mean())

	@property
	def empty(self) -> bool:
		"""No usable image: nothing for the models or the band rule to judge."""
		return self.valid_share < MIN_VALID_SHARE


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


def grid_crops(src, tiles: list[Tile], where: np.ndarray, scale: float, native_mpp: float, count: int, seed: int):
	"""Render `count` spread CLIP tiles whose centre lies in `where` (overview pixels)."""
	to_cog = Transformer.from_crs(4326, src.crs, always_xy=True)
	inverse = ~src.transform
	h, w = where.shape
	usable = []
	for tile in tiles:
		col, row = inverse @ to_cog.transform(*tile.centre)
		x, y = int(col / scale), int(row / scale)
		if 0 <= x < w and 0 <= y < h and where[y, x]:
			usable.append((x, y, tile))
	if not usable:
		return []
	by_point = {(float(x), float(y)): tile for x, y, tile in usable}
	points = spread_points(np.array(list(by_point), float), count, seed)
	lon, lat = Transformer.from_crs(src.crs, 4326, always_xy=True).transform(
		*(src.transform @ (src.width / 2, src.height / 2))
	)
	utm = CRS.from_string(get_utm_string_from_latlon(lat, lon))
	to_utm = Transformer.from_crs(4326, utm, always_xy=True)
	mpp = max(CROP_MPP, native_mpp)
	crops = []
	for point in points:
		tile = by_point[point]
		x0, y0, x1, y1 = tile.window
		cx, cy = to_utm.transform(*tile.centre)
		half_w, half_h = (x1 - x0) * GRID_MPP / 2, (y1 - y0) * GRID_MPP / 2
		bounds = (cx - half_w, cy - half_h, cx + half_w, cy + half_h)
		width, height = max(1, round(2 * half_w / mpp)), max(1, round(2 * half_h / mpp))
		# A VRT that is exactly the tile on the UTM grid at the crop resolution.
		grid = from_origin(bounds[0], bounds[3], 2 * half_w / width, 2 * half_h / height)
		with WarpedVRT(src, crs=utm, transform=grid, width=width, height=height, resampling=Resampling.bilinear) as vrt:
			data = vrt.read(indexes=list(range(1, min(src.count, 3) + 1)))
		footprint = shape(transform_geom(utm, 'EPSG:4326', mapping(box(*bounds))))
		crops.append(Crop(rgb_of(data), footprint, mpp, GRID_PICKER, grid_window=tile.window))
	return crops


def native_crops(src, valid: np.ndarray, scale: float, native_mpp: float, crop_px: int, count: int, seed: int):
	"""`count` native-resolution windows of up to `crop_px`, wholly inside the data where possible."""
	cw, ch = min(crop_px, src.width), min(crop_px, src.height)
	half = int(np.ceil(max(cw, ch) / 2 / scale))
	eligible = inside(valid, half)
	ys, xs = np.nonzero(eligible if eligible.any() else valid)
	crops = []
	for x, y in spread_points(np.column_stack((xs, ys)).astype(float), count, seed):
		col = int(np.clip((x + 0.5) * scale - cw / 2, 0, src.width - cw))
		row = int(np.clip((y + 0.5) * scale - ch / 2, 0, src.height - ch))
		window = Window(col, row, cw, ch)
		crops.append(
			Crop(
				rgb_of(src.read(window=window)),
				window_footprint(src, window),
				native_mpp,
				CROP_PICKER,
				cog_window=(col, row, cw, ch),
			)
		)
	return crops


def read_inputs(
	cog: str,
	seed: int = 0,
	overview_px: int = OVERVIEW_PX,
	crop_px: int = CROP_PX,
	crop_count: int = CROP_COUNT,
	tiles: list[Tile] | None = None,
) -> Inputs:
	"""Read the overview and crops of the COG at `cog` (path or URL); `tiles` are the
	dataset's CLIP tiles, if the embedding stage has run. The whole orthophoto is judged:
	the area of interest is a check of its own and plays no part here."""
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
		scale = src.width / w
		rows, cols = np.nonzero(valid)
		valid_window = (
			Window(
				cols.min() * scale,
				rows.min() * scale,
				(cols.max() + 1 - cols.min()) * scale,
				(rows.max() + 1 - rows.min()) * scale,
			)
			if valid.any()
			else Window(0, 0, src.width, src.height)
		)
		native_mpp = ground_mpp(src, src.width / 2, src.height / 2)
		crops = []
		if valid.mean() >= MIN_VALID_SHARE:
			crops = grid_crops(src, tiles or [], valid, scale, native_mpp, crop_count, seed)
			if not crops:
				crops = native_crops(src, valid, scale, native_mpp, crop_px, crop_count, seed)
		return Inputs(
			overview=overview,
			valid=valid,
			bands=bands,
			overview_mpp=native_mpp * scale,
			native_mpp=native_mpp,
			size=(src.width, src.height),
			footprint=window_footprint(src, valid_window),
			crops=crops,
			settings={
				'overview_px': overview_px,
				'crop_px': crop_px,
				'crop_count': crop_count,
				'crop_picker': crops[0].picker if crops else None,
				'seed': seed,
			},
		)
