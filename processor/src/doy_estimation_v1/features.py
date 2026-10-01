"""Model inputs of one ortho, built exactly as the research pipeline built them.

Ports of side_projects/doy_estimation/{prep_ortho,prep_s2,assemble}.py (only
the parts the deployed model uses): 16 random 10 cm patches inside the AOI,
the ortho resampled to the S2 10 m grid, the per-week AOI-mean S2 series with
ortho<->S2 match features, the flight-year week window and the site facts.
The patch sampling is seeded by the dataset id, so reruns are reproducible.
"""

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
import rasterio
import shapely.geometry
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.warp import reproject, transform_bounds, transform_geom
from rasterio.windows import from_bounds
from scipy.ndimage import uniform_filter

from .circular import NBINS, days_in_year

PATCH_PX = 224
N_PATCHES = 16
PATCH_GSD_M = 0.10
MASK_PX = 2048

S2_BANDS = ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B8A', 'B09', 'B11', 'B12']
MATCH_NAMES = [
	'n_frac',
	'r_bright',
	'r_red',
	'r_green',
	'r_blue',
	'r_gchroma',
	'r_grvi',
	'r_grvi_ndvi',
	'r_bright_nir',
	'd_gchroma',
	'd_rchroma',
	'r_rank',
]
S2_MAX_SIDE = 160
MIN_PIX = 12
WEEKS = 64
WINDOW_PAD_DAYS = 35
WEEK_FEATURES = 32


@dataclass
class S2Grid:
	"""A 10 m grid in a UTM CRS; x/y are the upper-left corners of the cells
	(x ascending, y descending), as in the sentle cubes."""

	crs: rasterio.crs.CRS
	x: np.ndarray
	y: np.ndarray

	@property
	def transform(self):
		return rasterio.transform.from_origin(float(self.x.min()), float(self.y.max()), 10, 10)

	@property
	def shape(self):
		return (len(self.y), len(self.x))


@dataclass
class S2Cube:
	"""Weekly composites over an S2Grid: values (T, 12, H, W) float32 DN,
	NaN where nothing is clear; time ascending."""

	grid: S2Grid
	time: np.ndarray
	values: np.ndarray
	aoi: np.ndarray  # (H, W) bool, the AOI rasterised on the grid; all False without an AOI


# ----------------------------------------------------------------- ortho views
def _valid_centres(mask, win_px, min_frac, rng, n):
	h, w = mask.shape
	half = max(1, int(round(win_px / 2)))
	frac = uniform_filter(mask.astype(np.float32), size=max(1, int(win_px)), mode='constant')
	good = frac >= min(min_frac, 0.999)
	good[:half, :] = False
	good[-half:, :] = False
	good[:, :half] = False
	good[:, -half:] = False
	rr, cc = np.nonzero(good)
	if len(rr) == 0:
		return None
	idx = rng.choice(len(rr), size=n, replace=len(rr) < n)
	return np.stack([rr[idx], cc[idx]], 1)


def _read(src, bounds, shape, aoi=None):
	"""RGB + validity (dataset mask AND AOI) for `bounds` resampled to `shape`.
	Reads the in-dataset part into a zero canvas: boundless reads bypass the
	COG overviews."""
	x0, y0, x1, y1 = bounds
	h, w = shape
	img = np.zeros((3, h, w), np.uint8)
	m = np.zeros((h, w), bool)
	L, B, R, T = src.bounds
	ix0, iy0, ix1, iy1 = max(x0, L), max(y0, B), min(x1, R), min(y1, T)
	if ix1 > ix0 and iy1 > iy0:
		c0 = int(round((ix0 - x0) / (x1 - x0) * w))
		c1 = int(round((ix1 - x0) / (x1 - x0) * w))
		r0 = int(round((y1 - iy1) / (y1 - y0) * h))
		r1 = int(round((y1 - iy0) / (y1 - y0) * h))
		if c1 > c0 and r1 > r0:
			win = from_bounds(ix0, iy0, ix1, iy1, src.transform)
			img[:, r0:r1, c0:c1] = src.read(
				[1, 2, 3], window=win, out_shape=(3, r1 - r0, c1 - c0), resampling=Resampling.average
			)
			m[r0:r1, c0:c1] = (
				src.dataset_mask(window=win, out_shape=(r1 - r0, c1 - c0), resampling=Resampling.nearest) > 0
			)
	if aoi is not None:
		tr = rasterio.transform.from_bounds(x0, y0, x1, y1, w, h)
		m &= rasterize([aoi], out_shape=(h, w), transform=tr, fill=0, default_value=1, dtype=np.uint8).astype(bool)
	img *= m[None]
	return img, m


class OrthoNotSampleable(ValueError):
	"""The ortho has no 22.4 m patch to sample (too small, or outside its AOI): no estimate is possible."""


@dataclass
class OrthoViews:
	patches: np.ndarray  # (n, 224, 224, 3) uint8
	gsd: float
	region: tuple  # sampling region in EPSG:3857
	aoi_3857: dict | None


def ortho_views(cog_path: str, dataset_id: int, lat: float, aoi_4326: dict | None) -> OrthoViews:
	"""16 patches of 22.4 m at 10 cm inside the AOI (else the data mask)."""
	rng = np.random.default_rng(int(dataset_id))
	with rasterio.Env(GDAL_CACHEMAX=256, GDAL_NUM_THREADS=1), rasterio.open(cog_path) as src:
		assert src.crs.to_epsg() == 3857, f'COG must be EPSG:3857, got {src.crs}'
		scale = 1.0 / np.cos(np.deg2rad(lat))  # mercator m per ground m
		gsd = float(np.float32(src.res[0] / scale))
		aoi = None
		if aoi_4326 is not None:
			aoi = transform_geom('EPSG:4326', 'EPSG:3857', aoi_4326)
			ax0, ay0, ax1, ay1 = shapely.geometry.shape(aoi).bounds
			L, B, R, T = src.bounds
			region = (max(ax0, L), max(ay0, B), min(ax1, R), min(ay1, T))
			if region[2] <= region[0] or region[3] <= region[1]:
				raise OrthoNotSampleable('AOI does not overlap the ortho')
		else:
			region = tuple(src.bounds)
		rx0, ry0, rx1, ry1 = region
		rw, rh = rx1 - rx0, ry1 - ry0
		m_px = max(rw, rh) / MASK_PX
		mh, mw = max(1, int(round(rh / m_px))), max(1, int(round(rw / m_px)))
		_, msk = _read(src, region, (mh, mw), aoi)
		m_px_x, m_px_y = rw / mw, rh / mh

		size = PATCH_PX * PATCH_GSD_M * scale
		patches = None
		for min_frac in (1.0, 0.7, 0.3):
			cen = _valid_centres(msk, size / m_px_x, min_frac, rng, N_PATCHES)
			if cen is None:
				continue
			imgs = []
			for rr, cc in cen:
				cx = rx0 + (cc + 0.5) * m_px_x
				cy = ry1 - (rr + 0.5) * m_px_y
				img, _ = _read(src, (cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2), (PATCH_PX, PATCH_PX), aoi)
				imgs.append(img.transpose(1, 2, 0))
			patches = np.stack(imgs)
			break
	if patches is None:
		raise OrthoNotSampleable('no valid 10 cm patch inside the AOI')
	return OrthoViews(patches=patches, gsd=gsd, region=region, aoi_3857=aoi)


def ortho_on_grid(cog_path: str, views: OrthoViews, lat: float, grid: S2Grid):
	"""Mean ortho RGB (3, H, W) on the S2 grid and the valid fraction (H, W),
	or (None, None) when the ortho does not overlap the grid."""
	scale = 1.0 / np.cos(np.deg2rad(lat))
	rx0, ry0, rx1, ry1 = views.region
	with rasterio.Env(GDAL_CACHEMAX=256, GDAL_NUM_THREADS=1), rasterio.open(cog_path) as src:
		xs, ys = grid.x.astype(float), grid.y.astype(float)
		cb = transform_bounds(grid.crs, src.crs, xs.min(), ys.min() - 10, xs.max() + 10, ys.max())
		gb = (max(cb[0], rx0), max(cb[1], ry0), min(cb[2], rx1), min(cb[3], ry1))
		if gb[2] <= gb[0] or gb[3] <= gb[1]:
			return None, None
		step = max(1.0 * scale, (gb[2] - gb[0]) / 3000, (gb[3] - gb[1]) / 3000)
		gw = max(1, int(round((gb[2] - gb[0]) / step)))
		gh = max(1, int(round((gb[3] - gb[1]) / step)))
		img, m = _read(src, gb, (gh, gw), views.aoi_3857)
		src_tr = rasterio.transform.from_bounds(*gb, gw, gh)
		m = m.astype(np.float32)
		stack = np.concatenate([img.astype(np.float32) * m[None], m[None]], 0)
		dst = np.zeros((4,) + grid.shape, np.float32)
		reproject(
			stack,
			dst,
			src_transform=src_tr,
			src_crs=src.crs,
			dst_transform=grid.transform,
			dst_crs=grid.crs,
			resampling=Resampling.average,
		)
	valid = dst[3]
	rgb = np.where(valid > 0, dst[:3] / np.maximum(valid, 1e-6), np.nan)
	# the research pipeline cached both as float16
	return rgb.astype(np.float16).astype(np.float32), valid.astype(np.float16).astype(np.float32)


# ------------------------------------------------------------ S2 week series
def _corr(a, b):
	m = ~(np.isnan(a) | np.isnan(b))
	n = m.sum(1)
	a0, b0 = np.where(m, a, 0.0), np.where(m, b, 0.0)
	ma, mb = a0.sum(1) / np.maximum(n, 1), b0.sum(1) / np.maximum(n, 1)
	da, db = np.where(m, a - ma[:, None], 0.0), np.where(m, b - mb[:, None], 0.0)
	den = np.sqrt((da**2).sum(1) * (db**2).sum(1))
	r = (da * db).sum(1) / np.where(den > 0, den, np.nan)
	r[n < MIN_PIX] = np.nan
	return r


def _rank(x):
	out = np.full_like(x, np.nan)
	for i in range(x.shape[0]):
		m = ~np.isnan(x[i])
		if m.sum():
			out[i, m] = np.argsort(np.argsort(x[i, m]))
	return out


def s2_series(cube: S2Cube, g10: np.ndarray | None, g10_valid: np.ndarray | None) -> dict:
	"""AOI-mean S2 bands, clear share and ortho<->S2 match features per week."""
	aoi = cube.aoi
	if aoi.sum() == 0:
		aoi = (g10_valid > 0.5) if g10_valid is not None else np.ones(aoi.shape, bool)
	rows, cols = np.nonzero(aoi)
	r0, r1, c0, c1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
	step = int(np.ceil(max(r1 - r0, c1 - c0) / S2_MAX_SIDE))
	sl = (slice(r0, r1, step), slice(c0, c1, step))
	aoi = aoi[sl]
	pix = cube.values[:, :, sl[0], sl[1]][:, :, aoi]  # (T, 12, N)
	T = len(cube.time)
	s2clear = ~np.isnan(pix[:, 1:4]).any(1)
	with np.errstate(invalid='ignore'), warnings.catch_warnings():
		warnings.simplefilter('ignore', RuntimeWarning)
		series = np.nanmean(pix, axis=2).astype(np.float32)
	out = {'time': cube.time, 'series': series, 'clear': s2clear.mean(1).astype(np.float32), 'match': None}
	if g10 is None:
		return out
	g = g10[:, sl[0], sl[1]][:, aoi]
	good = g10_valid[sl[0], sl[1]][aoi] > 0.8
	g = np.where(good[None], g, np.nan)
	R, G, B = g
	with np.errstate(invalid='ignore', divide='ignore'), warnings.catch_warnings():
		warnings.simplefilter('ignore', RuntimeWarning)
		obright = (R + G + B) / 3
		ogch, orch = G / (R + G + B), R / (R + G + B)
		ogrvi = (G - R) / (G + R)
		b2, b3, b4, b8 = (pix[:, S2_BANDS.index(b)] for b in ('B02', 'B03', 'B04', 'B08'))
		sb = b2 + b3 + b4
		sgch, srch = b3 / sb, b4 / sb
		sgrvi = (b3 - b4) / (b3 + b4)
		sndvi = (b8 - b4) / (b8 + b4)
		both = s2clear & good[None]

		def rep(x):
			return np.broadcast_to(x, (T, len(x)))

		feats = {
			'n_frac': both.sum(1) / max(1, good.sum()),
			'r_bright': _corr(rep(obright), sb),
			'r_red': _corr(rep(R), b4),
			'r_green': _corr(rep(G), b3),
			'r_blue': _corr(rep(B), b2),
			'r_gchroma': _corr(rep(ogch), sgch),
			'r_grvi': _corr(rep(ogrvi), sgrvi),
			'r_grvi_ndvi': _corr(rep(ogrvi), sndvi),
			'r_bright_nir': _corr(rep(obright), b8),
			'd_gchroma': np.nanmean(np.where(both, sgch, np.nan), 1) - np.nanmean(ogch),
			'd_rchroma': np.nanmean(np.where(both, srch, np.nan), 1) - np.nanmean(orch),
			'r_rank': _corr(_rank(np.where(both, rep(obright), np.nan)), _rank(np.where(both, sb, np.nan))),
		}
	out['match'] = np.stack([feats[k] for k in MATCH_NAMES], 1).astype(np.float32)
	return out


def week_features(series, clear, match):
	"""(T, 32): 12 sqrt bands, NDVI, NDMI, GRVI, green/red chroma, clear share,
	S2 flag, 12 match features and their flag; NaN -> 0 with explicit flags."""
	s2 = series[:, :12] / 10000.0
	b = {k: s2[:, i] for i, k in enumerate(S2_BANDS)}
	with np.errstate(invalid='ignore', divide='ignore'):
		ndvi = (b['B08'] - b['B04']) / (b['B08'] + b['B04'])
		ndmi = (b['B08'] - b['B11']) / (b['B08'] + b['B11'])
		grvi = (b['B03'] - b['B04']) / (b['B03'] + b['B04'])
		vis = b['B02'] + b['B03'] + b['B04']
		gch, rch = b['B03'] / vis, b['B04'] / vis
	s2ok = ~np.isnan(s2).any(1)
	opt = np.concatenate(
		[np.sqrt(np.clip(s2, 0, None)), ndvi[:, None], ndmi[:, None], grvi[:, None], gch[:, None] * 3 - 1, rch[:, None] * 3 - 1], 1
	)
	opt = np.where(s2ok[:, None], np.nan_to_num(opt), 0.0)
	if match is None:
		m, mok = np.zeros((len(series), len(MATCH_NAMES))), np.zeros(len(series), bool)
	else:
		mok = (~np.isnan(match[:, 1])) & (match[:, 0] > 0.3)
		m = np.where(mok[:, None], np.nan_to_num(match), 0.0)
	out = np.concatenate([opt, clear[:, None], s2ok[:, None], m, mok[:, None]], 1)
	return np.clip(np.nan_to_num(out, nan=0.0, posinf=0.0, neginf=0.0), -10, 10).astype(np.float32)


def flight_year_window(year: int) -> tuple[pd.Timestamp, pd.Timestamp]:
	"""Composite centres the model looks at: the flight year +- 35 days."""
	start = pd.Timestamp(year, 1, 1) - pd.Timedelta(days=WINDOW_PAD_DAYS)
	return start, pd.Timestamp(year, 1, 1) + pd.Timedelta(days=days_in_year(year) + WINDOW_PAD_DAYS)


def s2_window(s2: dict, year: int) -> dict:
	"""Flight-year week tokens -> dict(f, pos, has_match), {} without weeks."""
	t = pd.DatetimeIndex(s2['time'])
	dd = (t - pd.Timestamp(year, 1, 1)).total_seconds().values / 86400.0
	diy = float(days_in_year(year))
	sel = (dd >= -WINDOW_PAD_DAYS) & (dd < diy + WINDOW_PAD_DAYS)
	if not sel.sum():
		return {}
	f = week_features(s2['series'], s2['clear'], s2['match'])[sel][:WEEKS]
	return {'f': f, 'pos': dd[sel][:WEEKS] * NBINS / diy, 'has_match': s2['match'] is not None and bool(f[:, -1].any())}


def static_features(lat, lon, year, has_s2, has_match, gsd) -> np.ndarray:
	la, lo = np.deg2rad(lat), np.deg2rad(lon)
	static = np.array(
		[np.sin(la), np.cos(la), np.sin(lo), np.cos(lo), lat / 90.0, np.sign(lat), (year - 2021) / 4.0, float(has_s2), float(has_match)],
		np.float32,
	)
	return np.concatenate([static, [np.log10(np.float32(gsd)) + 1.5]]).astype(np.float32)


def site_inputs(emb: np.ndarray, window: dict, lat: float, lon: float, year: int, gsd: float) -> dict:
	"""Batch-of-one model inputs, as the research assemble.py/deploy.py built them."""
	s2w = np.zeros((1, WEEKS, WEEK_FEATURES), np.float16)
	s2pos, s2m = np.zeros((1, WEEKS), np.float32), np.zeros((1, WEEKS), bool)
	if window:
		k = len(window['f'])
		s2w[0, :k], s2pos[0, :k], s2m[0, :k] = window['f'], window['pos'], True
	e = np.zeros((1, N_PATCHES, emb.shape[1]), np.float16)
	v = np.zeros((1, N_PATCHES), bool)
	k = min(N_PATCHES, len(emb))
	e[0, :k], v[0, :k] = emb[:k], True
	static = static_features(lat, lon, year, bool(window), bool(window.get('has_match', False)), gsd)
	return {'static': static[None], 's2w': s2w, 's2pos': s2pos, 's2m': s2m, 'p10_emb': e, 'p10_valid': v}
