"""Render one crop: the tile square at 5 cm from the COG, plus deadwood and forest overlays.

The COG is read through a clamped window around the square (never a boundless read, which
skips the overviews and once used 31 GB on a very large ortho) and warped onto the square's
5 cm UTM grid. The overlays are what the judges see: a translucent fill and a solid outline.

Render v2 (DT-1560): the forest layer often covers the whole crop. With a faint fill and an
outline only at the mask's inner edge, such a crop showed no gold edge at all, and the judges
reported the forest as missing. Now the outline also runs where the prediction meets the crop
border, the forest fill and outline are stronger, and the prompt states each layer's share.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform_bounds
from rasterio.windows import Window
from rasterio.windows import from_bounds as window_from_bounds
from rasterio.windows import transform as window_transform

CROP_PX = 1024  # 51.2 m at 5 cm
RENDER_VERSION = 'overlay-v2'
COLORS = {'deadwood': (30, 135, 255), 'forest': (255, 202, 50)}
FILL_ALPHA = {'deadwood': 0.3, 'forest': 0.4}
OUTLINE_PX = {'deadwood': 1, 'forest': 3}
OUTSIDE_AOI = 0.35  # brightness kept outside the AOI


@dataclass
class Crop:
	rgb: np.ndarray  # (H, W, 3) uint8
	valid: np.ndarray  # (H, W) bool, real image data
	masks: dict  # layer -> (H, W) bool prediction mask
	mpp: float
	in_aoi: np.ndarray | None = None  # (H, W) bool; outside the AOI is darkened for the judges

	@property
	def valid_fraction(self) -> float:
		return float(self.valid.mean())

	def cover(self, layer: str) -> float:
		return float(self.masks[layer].mean())


def render_crop(src: rasterio.DatasetReader, epsg: int, square: tuple, layers: dict[str, Iterable], aoi=None) -> Crop:
	"""Warp the COG onto the square's 5 cm grid and rasterise the prediction polygons and AOI (in UTM)."""
	dst = from_bounds(*square, CROP_PX, CROP_PX)
	margin = 5.0
	b = transform_bounds(
		f'EPSG:{epsg}', src.crs, square[0] - margin, square[1] - margin, square[2] + margin, square[3] + margin
	)
	win = window_from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
	win = win.intersection(Window(0, 0, src.width, src.height))
	# Read no finer than the output needs; COG overviews serve coarser requests.
	scale = max(1.0, max(win.width, win.height) / (CROP_PX * 1.2))
	h, w = max(1, round(win.height / scale)), max(1, round(win.width / scale))
	data = src.read([1, 2, 3], window=win, out_shape=(3, h, w), resampling=Resampling.bilinear)
	valid_src = src.dataset_mask(window=win, out_shape=(h, w), resampling=Resampling.nearest)
	src_t = window_transform(win, src.transform) @ rasterio.Affine.scale(win.width / w, win.height / h)
	rgb = np.zeros((3, CROP_PX, CROP_PX), 'uint8')
	valid = np.zeros((CROP_PX, CROP_PX), 'uint8')
	for i in range(3):
		reproject(
			data[i],
			rgb[i],
			src_transform=src_t,
			src_crs=src.crs,
			dst_transform=dst,
			dst_crs=f'EPSG:{epsg}',
			resampling=Resampling.bilinear,
		)
	reproject(
		valid_src,
		valid,
		src_transform=src_t,
		src_crs=src.crs,
		dst_transform=dst,
		dst_crs=f'EPSG:{epsg}',
		resampling=Resampling.nearest,
	)
	ok = valid > 0
	masks = {}
	for layer, geoms in layers.items():
		shapes = [(g, 1) for g in geoms]
		mask = rasterize(shapes, out_shape=(CROP_PX, CROP_PX), transform=dst) > 0 if shapes else np.zeros_like(ok)
		masks[layer] = mask & ok
	in_aoi = rasterize([(aoi, 1)], out_shape=(CROP_PX, CROP_PX), transform=dst) > 0 if aoi is not None else None
	return Crop(rgb=rgb.transpose(1, 2, 0), valid=ok, masks=masks, mpp=(square[2] - square[0]) / CROP_PX, in_aoi=in_aoi)


def outline(mask: np.ndarray, width: int = 1) -> np.ndarray:
	"""The mask's edge, `width` pixels wide, inside the mask. The crop border counts as an edge:
	a prediction that fills the crop gets a frame instead of no outline at all."""
	inner = np.pad(mask, 1, constant_values=False)
	for _ in range(width):
		eroded = inner.copy()
		eroded[1:] &= inner[:-1]
		eroded[:-1] &= inner[1:]
		eroded[:, 1:] &= inner[:, :-1]
		eroded[:, :-1] &= inner[:, 1:]
		inner = eroded
	return mask & ~inner[1:-1, 1:-1]


def _base(crop: Crop) -> np.ndarray:
	base = crop.rgb.astype(np.float32)
	if crop.in_aoi is not None:
		base[~crop.in_aoi] *= OUTSIDE_AOI
	return base


def overlay(crop: Crop, layer: str) -> Image.Image:
	"""The raw crop with one layer as translucent fill plus solid outline, as the judges see it."""
	base = _base(crop)
	color = np.array(COLORS[layer], np.float32)
	m = crop.masks[layer]
	alpha = FILL_ALPHA[layer]
	base[m] = base[m] * (1 - alpha) + color * alpha
	base[outline(m, OUTLINE_PX[layer])] = color
	return Image.fromarray(base.clip(0, 255).astype('uint8'))


def judge_images(crop: Crop) -> list[Image.Image]:
	"""Image 1 raw RGB, image 2 deadwood overlay, image 3 forest overlay (prompt order)."""
	raw = Image.fromarray(_base(crop).clip(0, 255).astype('uint8'))
	return [raw, overlay(crop, 'deadwood'), overlay(crop, 'forest')]
