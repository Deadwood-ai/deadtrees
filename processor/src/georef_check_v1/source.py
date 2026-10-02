"""The drone image on a bounded EPSG:3857 grid, masked to its usable area."""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform_bounds, transform_geom

from .evidence import Grid

GRID_PIXELS = 1400  # longest side of the matching grid
MASK_EROSION_PX = 11  # drop the resampled nodata fringe
NEUTRAL = 127  # fill outside the usable area, so the matcher ignores it


@dataclass
class Source:
	grid: Grid
	image: np.ndarray  # (H, W, 3) uint8, NEUTRAL outside `mask`
	mask: np.ndarray  # (H, W) bool: valid data inside the AOI
	native_m_per_px: float
	used_aoi: bool


def read_source(cog_path: str, aoi_4326: dict | None, grid_pixels: int = GRID_PIXELS) -> Source:
	"""Read the COG (via its overviews) onto a grid of at most `grid_pixels` per
	side. The usable area is the data mask, eroded, intersected with the AOI."""
	with rasterio.open(cog_path) as src:
		if src.count < 3:
			raise ValueError('georeferencing check needs an RGB COG')
		bounds = transform_bounds(src.crs, 'EPSG:3857', *src.bounds, densify_pts=21)
		width_m, height_m = bounds[2] - bounds[0], bounds[3] - bounds[1]
		res = max(width_m / grid_pixels, height_m / grid_pixels, width_m / src.width, height_m / src.height)
		w, h = max(16, math.ceil(width_m / res)), max(16, math.ceil(height_m / res))
		grid = Grid(tuple(bounds), w, h)
		target = from_bounds(*bounds, w, h)
		# read through the overviews first; warping straight from full resolution
		# would touch every block of very large orthos
		factor = min(1.0, 2000 / max(src.width, src.height))
		sw, sh = max(1, round(src.width * factor)), max(1, round(src.height * factor))
		rgb = src.read([1, 2, 3], out_shape=(3, sh, sw), resampling=Resampling.bilinear)
		valid = src.dataset_mask(out_shape=(sh, sw), resampling=Resampling.nearest)
		source_transform = src.transform * src.transform.scale(src.width / sw, src.height / sh)
		if rgb.dtype != np.uint8:
			raise ValueError('georeferencing check needs an 8-bit RGB COG')
		out = np.zeros((3, h, w), np.uint8)
		mask = np.zeros((h, w), np.uint8)
		reproject(rgb, out, src_transform=source_transform, src_crs=src.crs, dst_transform=target, dst_crs='EPSG:3857', resampling=Resampling.bilinear)
		reproject(valid, mask, src_transform=source_transform, src_crs=src.crs, dst_transform=target, dst_crs='EPSG:3857', resampling=Resampling.nearest)
		native = width_m / src.width
	usable = cv2.erode((mask > 0).astype(np.uint8), np.ones((MASK_EROSION_PX, MASK_EROSION_PX), np.uint8)) > 0
	used_aoi = False
	if aoi_4326 is not None:
		aoi = rasterize([transform_geom('EPSG:4326', 'EPSG:3857', aoi_4326)], out_shape=(h, w), transform=target, fill=0, default_value=1, dtype=np.uint8) > 0
		if (usable & aoi).any():
			usable &= aoi
			used_aoi = True
	image = out.transpose(1, 2, 0).copy()
	image[~usable] = NEUTRAL
	return Source(grid, image, usable, native * grid.metres_per_pixel() / grid.res, used_aoi)
