"""Extract fixed-resolution patches from an orthophoto and embed them with CLIP.

Adapted from the standalone ``deadtrees-search-modular`` package and wired into
the deadtrees processor. The orthophoto is reprojected to a uniform 10cm ground
sample distance (UTM) using the same :func:`image_reprojector` helper the
segmentation stages use, then tiled into non-overlapping ``PATCH_SIZE`` windows.
Tiles whose nodata fraction exceeds :data:`NODATA_THRESHOLD` are skipped so the
CLIP embeddings are only computed over real imagery — tiles must be almost
entirely (>99%) real data.

nodata is detected robustly via the shared :func:`read_nodata_mask` helper,
which honours a real alpha band, an internal mask, a declared nodata value, a
mislabeled binary mask band and — as a last resort — solid white/black fill.

Each returned :class:`PatchEmbedding` carries an L2-normalized image embedding
plus the tile footprint as a WGS84 (EPSG:4326) polygon so the frontend can
highlight matching tiles on the map.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, List, Tuple

import numpy as np
import rasterio
from PIL import Image
from rasterio.warp import transform_bounds
from rasterio.windows import Window

from shared.embedding_model import ModelBundle, encode_images

from ..utils.segmentation import image_reprojector
from ..utils.nodata import read_nodata_mask

# A 512px CLIP patch at 10cm GSD covers 51.2m on the ground. Non-overlapping.
PATCH_SIZE = 512
PATCH_STRIDE = 512
# Force a uniform 10cm resolution. Orthos coarser than this are upsampled and
# orthos finer than this are downsampled so every tile embeds the same scale.
GSD_M = 0.10
# Skip tiles unless they are >99% real data (i.e. at most 1% nodata). Tiles
# clipping the ortho footprint carry a strip of fill that pollutes the embedding.
NODATA_THRESHOLD = 0.01


@dataclass
class PatchEmbedding:
	# Tile footprint in WGS84 as (min_lon, min_lat, max_lon, max_lat).
	geo_bbox_4326: Tuple[float, float, float, float]
	# Pixel window in the reprojected 10cm raster as (x0, y0, x1, y1).
	pixel_bbox: Tuple[int, int, int, int]
	embedding: np.ndarray
	nodata_fraction: float


def _iter_tiles(vrt) -> Iterator[Tuple[Image.Image, PatchEmbedding]]:
	"""Yield (PIL image, partially-filled PatchEmbedding) for each kept tile."""
	width, height = vrt.width, vrt.height
	band_indexes = [1, 2, 3] if vrt.count >= 3 else list(range(1, vrt.count + 1))

	for y in range(0, height, PATCH_STRIDE):
		win_h = min(PATCH_SIZE, height - y)
		for x in range(0, width, PATCH_STRIDE):
			win_w = min(PATCH_SIZE, width - x)
			window = Window(x, y, win_w, win_h)

			# Fraction of pixels that are nodata (alpha / mask / declared nodata /
			# mislabeled mask band / solid fill), resolved once by image_reprojector.
			nodata = read_nodata_mask(vrt, window)
			nodata_fraction = float(np.mean(nodata))
			if nodata_fraction > NODATA_THRESHOLD:
				continue

			data = vrt.read(indexes=band_indexes, window=window)
			arr = np.where(nodata, 0, data)
			arr = np.moveaxis(arr, 0, -1)
			arr = np.clip(arr, 0, 255).astype(np.uint8)
			if arr.shape[2] == 1:
				arr = np.repeat(arr, 3, axis=2)
			img = Image.fromarray(arr)

			left, bottom, right, top = vrt.window_bounds(window)
			geo_bbox = transform_bounds(vrt.crs, 'EPSG:4326', left, bottom, right, top)

			yield img, PatchEmbedding(
				geo_bbox_4326=geo_bbox,
				pixel_bbox=(int(x), int(y), int(x + win_w), int(y + win_h)),
				embedding=np.empty(0),
				nodata_fraction=nodata_fraction,
			)


def embed_orthophoto_tiles(
	tif_path: str | Path,
	bundle: ModelBundle,
	batch_size: int = 8,
) -> List[PatchEmbedding]:
	"""Reproject to 10cm, tile, filter nodata and CLIP-embed an orthophoto."""
	tif_path = Path(tif_path)
	if not tif_path.exists():
		raise FileNotFoundError(f'Orthophoto not found: {tif_path}')

	# Force exactly GSD_M resolution by clamping both the min and max resolution.
	vrt = image_reprojector(str(tif_path), min_res=GSD_M, max_res=GSD_M)

	results: List[PatchEmbedding] = []
	images: List[Image.Image] = []
	metas: List[PatchEmbedding] = []

	def flush() -> None:
		if not images:
			return
		feats = encode_images(bundle, images).detach().cpu().float().numpy()
		for emb, meta in zip(feats, metas):
			meta.embedding = emb
			results.append(meta)
		images.clear()
		metas.clear()

	try:
		for img, meta in _iter_tiles(vrt):
			images.append(img)
			metas.append(meta)
			if len(images) >= batch_size:
				flush()
		flush()
	finally:
		vrt.close()

	return results
