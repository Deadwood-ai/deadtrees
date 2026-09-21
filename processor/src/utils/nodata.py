"""Bulletproof nodata resolution for reprojected orthophotos.

Orthos in the archive use every nodata convention imaginable:

* a proper alpha band (``ColorInterp.alpha``),
* an internal per-dataset / per-band mask,
* a declared nodata value (0, 255, NaN, 65535, -32768, ...),
* a 4th / extra band that is really an alpha but tagged ``undefined`` or
  ``gray`` so GDAL never treats it as a mask (e.g. dataset 3789), or
* nothing at all, with the footprint simply padded in solid white or black.

Every stage that reprojects an ortho (embeddings + all segmentation inferences)
goes through :func:`image_reprojector`, which builds a ``WarpedVRT`` with a
forced ``nodata=0``. That warp already makes ``vrt.read_masks(1)`` reflect a
real alpha band, an internal mask, a declared nodata value AND the triangular
warp border (all verified). So the only things GDAL cannot infer on its own —
and therefore the only things this module adds — are a *mislabeled* binary mask
band and, when the source carries no masking metadata whatsoever, a solid
white/black fill fallback.

That fill fallback is deliberately conservative: it only flags solid-white /
solid-black pixels that are *connected* to already-known nodata or to a true
raster edge, i.e. actual footprint padding. Saturated-white content inside the
footprint (snow, calibration panels, sunlit roofs) is not connected to the
border and is therefore kept.

Consumers read small windows, but padding connectivity is a property of the
whole raster: a plot placed on a huge white canvas has tens of thousands of
blank tiles that touch neither a raster edge nor known nodata. So the fallback
first builds a coarse, raster-wide padding map (:func:`_padding_map`, one extra
pass over the source, cached on the VRT) and seeds every window from it.

:func:`image_reprojector` resolves a :class:`NodataPolicy` once and stores it on
the returned VRT as ``.nodata_policy``. Consumers call
:func:`read_nodata_mask` instead of ``vrt.read_masks(1)`` to get a boolean tile
(``True`` = nodata) that honours all of the above.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np
import rasterio
import rasterio.enums

# An extra trailing band is treated as a (mislabeled) alpha mask when at least
# this fraction of sampled pixels are exactly 0 or 255 — i.e. it is binary —
# AND at least _MIN_NODATA_FRACTION of them are exactly 0, so it actually masks
# something. A continuous band (NIR, DEM, ...) fails the binary test and is left
# alone, so genuine multispectral data is never mistaken for a mask.
_BINARY_FRACTION = 0.98
_MIN_NODATA_FRACTION = 0.001
# Decimated read size for the binary-band probe; keeps the check O(1) on huge
# rasters while still being representative.
_SAMPLE = 1024

# Fill fallback: the raster-wide padding map works on cells of this many pixels.
# A cell counts only when every pixel in it is solid fill (or already nodata), so
# the map can never flag imagery; windows are read with a one-cell halo so that
# padding strips narrower than a cell still connect to it.
_PADDING_CELL = 32
# Upper bound on pixels read per strip while building the map (~200 MB of RGB).
_PADDING_STRIP_PIXELS = 64_000_000

# Bands whose colour interpretation marks them as real imagery — never a mask.
_COLOR_BANDS = frozenset(
	{
		rasterio.enums.ColorInterp.red,
		rasterio.enums.ColorInterp.green,
		rasterio.enums.ColorInterp.blue,
	}
)


@dataclass(frozen=True)
class NodataPolicy:
	"""How to derive the nodata mask for a source, beyond what ``read_masks`` gives.

	mask_band: 1-based index of an extra band to treat as an alpha mask (pixels
	    where it equals 0 are nodata), or None.
	treat_white_fill / treat_black_fill: last-resort heuristics, only enabled
	    when the source declares no masking at all.
	"""

	mask_band: Optional[int] = None
	treat_white_fill: bool = False
	treat_black_fill: bool = False


def _has_alpha_band(src) -> bool:
	ci = src.colorinterp
	return src.count >= 2 and bool(ci) and ci[-1] == rasterio.enums.ColorInterp.alpha


def _has_internal_mask(src) -> bool:
	"""True if the source carries an explicit .msk / internal mask band.

	Only reports a genuine per-dataset internal mask. ``nodata`` is handled
	separately, and ``alpha`` is reported by :func:`_has_alpha_band`; both would
	otherwise also appear here. ``all_valid`` means "no mask".
	"""
	return any(rasterio.enums.MaskFlags.per_dataset in flags for flags in src.mask_flag_enums)


def _detect_mask_band(src) -> Optional[int]:
	"""Return the index of a trailing binary mask band mislabeled as data, else None.

	Targets the dataset-3789 shape: an RGB image with a 4th (or later) band that
	is really a 0/255 alpha but tagged ``undefined``/``gray``, so nothing treats
	it as transparency.
	"""
	if src.count < 4:
		return None
	band = src.count  # the extra band is the trailing one
	ci = src.colorinterp[band - 1] if src.colorinterp else None
	if ci in _COLOR_BANDS:
		return None

	try:
		h = min(src.height, _SAMPLE)
		w = min(src.width, _SAMPLE)
		sample = src.read(band, out_shape=(h, w))
	except Exception:
		return None

	total = sample.size
	if total == 0:
		return None
	zeros = int(np.count_nonzero(sample == 0))
	binary = zeros + int(np.count_nonzero(sample == 255))
	if binary / total >= _BINARY_FRACTION and zeros / total >= _MIN_NODATA_FRACTION:
		return band
	return None


def resolve_nodata_policy(src) -> NodataPolicy:
	"""Resolve, once per source, how to detect nodata beyond ``read_masks``.

	Priority: a real alpha band / internal mask / declared nodata value are all
	already reflected by ``read_masks`` on the forced-``nodata=0`` warp, so trust
	it and add nothing. Otherwise try to recover a mislabeled binary mask band;
	failing that, fall back to solid white/black fill detection.
	"""
	if _has_alpha_band(src) or _has_internal_mask(src) or src.nodata is not None:
		return NodataPolicy()

	mask_band = _detect_mask_band(src)
	if mask_band is not None:
		return NodataPolicy(mask_band=mask_band)

	return NodataPolicy(treat_white_fill=True, treat_black_fill=True)


def _raster_edge_seed(vrt, window, shape) -> np.ndarray:
	"""Boolean (H, W) marking window borders that lie on the raster's outer edge.

	Footprint padding only occurs at true raster edges, so these pixels seed the
	connected-fill search. ``window=None`` means the whole raster (all edges).
	"""
	h, w = shape
	seed = np.zeros((h, w), dtype=bool)
	if window is None:
		seed[0, :] = seed[-1, :] = True
		seed[:, 0] = seed[:, -1] = True
		return seed
	col_off = int(getattr(window, 'col_off', 0))
	row_off = int(getattr(window, 'row_off', 0))
	if row_off <= 0:
		seed[0, :] = True
	if col_off <= 0:
		seed[:, 0] = True
	if row_off + h >= vrt.height:
		seed[-1, :] = True
	if col_off + w >= vrt.width:
		seed[:, -1] = True
	return seed


def _connected(fill: np.ndarray, seed: np.ndarray) -> np.ndarray:
	"""Subset of ``fill`` reachable from ``seed`` via 4-connectivity, within ``fill``.

	Iterative binary propagation to a fixpoint — no scipy/cv2 dependency. Only
	runs on the fill-fallback path (metadata-less orthos), and the common
	fully-padded tile short-circuits.
	"""
	reach = fill & seed
	if not reach.any():
		return np.zeros_like(fill)
	if fill.all():
		# Whole window is fill and at least one pixel is seeded → all padding.
		return fill
	while True:
		grown = reach.copy()
		grown[1:, :] |= reach[:-1, :]
		grown[:-1, :] |= reach[1:, :]
		grown[:, 1:] |= reach[:, :-1]
		grown[:, :-1] |= reach[:, 1:]
		grown &= fill
		if grown.sum() == reach.sum():
			return grown
		reach = grown


def _solid_fill(vrt, window, policy: NodataPolicy) -> np.ndarray:
	"""Boolean (H, W): pixels that are exactly solid white / black in all RGB bands."""
	n = min(3, vrt.count)
	rgb = vrt.read(indexes=list(range(1, n + 1)), window=window)
	fill = np.zeros(rgb.shape[1:], dtype=bool)
	if policy.treat_white_fill:
		fill |= np.all(rgb == 255, axis=0)
	if policy.treat_black_fill:
		fill |= np.all(rgb == 0, axis=0)
	return fill


def _label_connected(solid: np.ndarray, seed: np.ndarray) -> np.ndarray:
	"""Like :func:`_connected`, but labels components once instead of iterating.

	The padding map of a large ortho has millions of cells and paths thousands of
	cells long, where fixpoint propagation is too slow. Falls back to it when
	OpenCV is unavailable (e.g. minimal test environments).
	"""
	try:
		import cv2
	except ImportError:
		return _connected(solid, seed)
	_, labels = cv2.connectedComponents(solid.astype(np.uint8), connectivity=4)
	seeded = np.unique(labels[seed & solid])
	return np.isin(labels, seeded[seeded != 0])


def _padding_map(vrt, policy: NodataPolicy) -> np.ndarray:
	"""Coarse raster-wide map of footprint padding, built once and cached on the VRT.

	One boolean per ``_PADDING_CELL`` x ``_PADDING_CELL`` block: True when every
	pixel of the block is solid fill or already-known nodata AND the block is
	connected, through such blocks, to a raster edge or to known nodata. Blocks
	are all-or-nothing, so saturated content is never part of the map unless it
	is itself a fill-coloured region reaching the footprint border.
	"""
	cached = getattr(vrt, '_fill_padding_map', None)
	if cached is not None:
		return cached

	from rasterio.windows import Window

	cell = _PADDING_CELL
	cells_h = -(-vrt.height // cell)
	cells_w = -(-vrt.width // cell)
	solid = np.zeros((cells_h, cells_w), dtype=bool)
	seed = np.zeros((cells_h, cells_w), dtype=bool)
	seed[0, :] = seed[-1, :] = True
	seed[:, 0] = seed[:, -1] = True

	strip_cells = max(1, (_PADDING_STRIP_PIXELS // max(vrt.width, 1)) // cell)
	for cell_row in range(0, cells_h, strip_cells):
		row_off = cell_row * cell
		rows = min(strip_cells * cell, vrt.height - row_off)
		window = Window(0, row_off, vrt.width, rows)
		known = vrt.read_masks(1, window=window) == 0
		blank = known | _solid_fill(vrt, window, policy)

		# Pad to whole cells. Beyond the raster is padding by definition.
		n_cells = -(-rows // cell)
		pad = ((0, n_cells * cell - rows), (0, cells_w * cell - vrt.width))
		blank = np.pad(blank, pad, constant_values=True).reshape(n_cells, cell, cells_w, cell)
		known = np.pad(known, pad, constant_values=False).reshape(n_cells, cell, cells_w, cell)
		solid[cell_row : cell_row + n_cells] = blank.all(axis=(1, 3))
		seed[cell_row : cell_row + n_cells] |= known.any(axis=(1, 3))

	padding = _label_connected(solid, seed)
	try:
		vrt._fill_padding_map = padding
	except AttributeError:
		pass
	return padding


def _fill_padding_mask(vrt, window, policy: NodataPolicy) -> np.ndarray:
	"""Solid-fill footprint padding within ``window`` (``None`` = whole raster)."""
	from rasterio.windows import Window

	cell = _PADDING_CELL
	if window is None:
		col0, row0, w, h = 0, 0, vrt.width, vrt.height
	else:
		col0, row0 = int(window.col_off), int(window.row_off)
		w, h = int(window.width), int(window.height)

	# One-cell halo, clamped to the raster, so padding thinner than a cell inside
	# the window still reaches a padding cell of the neighbouring tile.
	hc0, hr0 = max(0, col0 - cell), max(0, row0 - cell)
	hc1, hr1 = min(vrt.width, col0 + w + cell), min(vrt.height, row0 + h + cell)
	if hc1 <= hc0 or hr1 <= hr0:
		return np.zeros((h, w), dtype=bool)
	halo = Window(hc0, hr0, hc1 - hc0, hr1 - hr0)

	known = vrt.read_masks(1, window=halo) == 0
	fill = _solid_fill(vrt, halo, policy)
	padding = _padding_map(vrt, policy)
	rows = (hr0 + np.arange(hr1 - hr0)) // cell
	cols = (hc0 + np.arange(hc1 - hc0)) // cell
	seed = known | _raster_edge_seed(vrt, halo, fill.shape) | padding[np.ix_(rows, cols)]

	grown = _connected(fill, seed)
	return grown[row0 - hr0 : row0 - hr0 + h, col0 - hc0 : col0 - hc0 + w]


def read_nodata_mask(vrt, window=None) -> np.ndarray:
	"""Boolean nodata mask (``True`` = nodata) for a window of an image_reprojector VRT.

	Combines the warp's own mask (alpha / internal mask / declared nodata /
	warp border) with whatever the resolved :class:`NodataPolicy` adds.
	"""
	policy = getattr(vrt, 'nodata_policy', None) or NodataPolicy()

	mask = vrt.read_masks(1, window=window) == 0

	if policy.mask_band is not None and policy.mask_band <= vrt.count:
		mask = mask | (vrt.read(policy.mask_band, window=window) == 0)

	if policy.treat_white_fill or policy.treat_black_fill:
		# Keep only footprint padding: fill connected to known nodata or a raster
		# edge, resolved raster-wide. Interior saturated content (snow, panels) is
		# preserved.
		mask = mask | _fill_padding_mask(vrt, window, policy)

	return mask
