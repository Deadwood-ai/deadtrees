"""In-process tree cover inference with the restor TCD SegFormer model.

This is a port of the semantic-segmentation path of ``tcd_pipeline``
(github.com/cmosig/tcd @ b8917ec, config ``segformer-mit-b5``) that used to run
in a separate ``deadtrees-tcd`` container. Running it inside the processor
gives it the same GPU, torch and asset handling as the other segmentation
models and removes the Docker volume / helper-container plumbing.

The port keeps the parts of the pipeline that shape the confidence map:

- tiles of 1024 px with at least 256 px overlap, edges spread evenly with
  ``np.linspace`` so the last tile ends on the raster edge;
- tiles whose mean over all bands (alpha included) is <= 1 or >= 254 are
  skipped and stay 0 (nodata);
- the transformers-5 ``SegformerImageProcessor`` normalisation (rescale and
  normalise fused into one ``normalize`` with mean/std scaled by 255);
- bilinear upsampling of the logits to the tile size, softmax, and
  ``uint8(255 * p_tree)`` by truncation;
- each tile keeps only its interior (128 px trimmed on sides that face another
  tile) and later tiles overwrite earlier ones, row by row.

The input must already be at the model's 0.1 m GSD (``predict_treecover``
reprojects to EPSG:3395 at exactly that resolution), so the pipeline's
blur-and-resize branch for other resolutions is not needed.
"""

from __future__ import annotations

import os
import queue
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np
import rasterio
import torch
from rasterio.windows import Window

from shared.settings import settings

TCD_MODEL_REPO = 'restor/tcd-segformer-mit-b5'
# Pin the Hugging Face revision so a republished checkpoint can never change
# predictions silently.
TCD_MODEL_REVISION = 'ab15b51cdad8fa53cf2ecbb6c738c00b524f3e5a'
TCD_MODEL_FILES = ('config.json', 'model.safetensors', 'preprocessor_config.json')
# Optional pre-provisioned copy of the files above (a directory, not a single file).
TCD_LOCAL_MODEL_DIR = Path(__file__).parent.parent.parent.parent / 'assets' / 'models' / 'tcd-segformer-mit-b5'

TCD_GSD_M = 0.1
TCD_TILE_SIZE = 1024
TCD_TILE_OVERLAP = 256
TCD_EDGE_TRIM = TCD_TILE_OVERLAP // 2
TCD_TREE_CLASS = 1
# Tiles per forward pass. The original pipeline used 1; batch 2 is ~15% faster
# on a 2080 Ti and changes a handful of pixels by one uint8 step (cuDNN picks
# different kernels); larger batches were not faster.
TCD_BATCH_SIZE = 2
# Tiles read ahead of the GPU on a background thread.
TCD_PREFETCH_TILES = 4

# transformers-5 SegformerImageProcessor: do_rescale + do_normalize are fused into
# one normalize() whose mean/std are scaled by 1 / rescale_factor in float32.
_RESCALE_FACTOR = 0.00392156862745098
_IMAGE_MEAN = (0.485, 0.456, 0.406)
_IMAGE_STD = (0.229, 0.224, 0.225)


@dataclass(frozen=True)
class TileResult:
	processed_tiles: int
	skipped_tiles: int
	device: str


def tile_edges(extent: int, tile_size: int = TCD_TILE_SIZE, overlap: int = TCD_TILE_OVERLAP) -> list[int]:
	"""Tile start offsets along one axis (tcd_pipeline ``Tiler`` with align_edges)."""
	if extent <= tile_size:
		count = 1
	else:
		count = 1 + int(np.ceil((extent - tile_size) / (tile_size - overlap)))
	return [int(edge) for edge in np.linspace(0, extent - tile_size, count).astype(int)]


def tile_windows(width: int, height: int) -> list[Window]:
	"""Row-major tile windows covering the raster; windows may extend past its edge."""
	# The pipeline drops the overlap only when the whole raster fits in one tile,
	# in which case both axes have a single tile anyway.
	return [
		Window(col, row, TCD_TILE_SIZE, TCD_TILE_SIZE)
		for row in tile_edges(height)
		for col in tile_edges(width)
	]


def is_empty_tile(tile: np.ndarray) -> bool:
	"""All-black or all-white tiles (mean over every band, alpha included) are skipped."""
	mean = tile.mean()
	return bool(mean <= 1 or mean >= 254)


def interior_window(window: Window, width: int, height: int) -> tuple[Window, slice, slice]:
	"""Part of a tile's prediction that is written to the confidence map.

	Returns the destination window and the row/column slices into the tile.
	Sides that face another tile lose ``TCD_EDGE_TRIM`` pixels; the result is
	clipped to the raster (single tiles can be larger than the raster).
	"""
	col_off, row_off = int(window.col_off), int(window.row_off)
	col_end, row_end = col_off + int(window.width), row_off + int(window.height)

	left = TCD_EDGE_TRIM if col_off > 0 else 0
	top = TCD_EDGE_TRIM if row_off > 0 else 0
	right = TCD_EDGE_TRIM if col_end < width else 0
	bottom = TCD_EDGE_TRIM if row_end < height else 0

	dst_col, dst_row = col_off + left, row_off + top
	dst_col_end = min(col_end - right, width)
	dst_row_end = min(row_end - bottom, height)

	rows = slice(dst_row - row_off, dst_row_end - row_off)
	cols = slice(dst_col - col_off, dst_col_end - col_off)
	return Window(dst_col, dst_row, dst_col_end - dst_col, dst_row_end - dst_row), rows, cols


def resolve_model_dir() -> Path:
	"""Directory with the pinned TCD checkpoint, downloaded once into a persistent cache."""
	if all((TCD_LOCAL_MODEL_DIR / name).is_file() for name in TCD_MODEL_FILES):
		return TCD_LOCAL_MODEL_DIR

	from huggingface_hub import snapshot_download
	from huggingface_hub.errors import LocalEntryNotFoundError

	download = dict(
		repo_id=TCD_MODEL_REPO,
		revision=TCD_MODEL_REVISION,
		cache_dir=settings.TCD_MODEL_CACHE_DIR,
		allow_patterns=list(TCD_MODEL_FILES),
	)
	try:
		return Path(snapshot_download(local_files_only=True, **download))
	except LocalEntryNotFoundError:
		Path(settings.TCD_MODEL_CACHE_DIR).mkdir(parents=True, exist_ok=True)
		return Path(snapshot_download(**download))


class TCDModel:
	"""SegFormer-MiT-B5 tree cover model returning uint8 tree confidence per tile."""

	def __init__(self, device: str | None = None):
		from transformers import SegformerForSemanticSegmentation

		self.device = torch.device(device or ('cuda' if torch.cuda.is_available() else 'cpu'))
		self.model = SegformerForSemanticSegmentation.from_pretrained(resolve_model_dir()).to(self.device)
		self.model.eval()
		self._mean = (torch.tensor(_IMAGE_MEAN, device=self.device) * (1.0 / _RESCALE_FACTOR)).view(1, 3, 1, 1)
		self._std = (torch.tensor(_IMAGE_STD, device=self.device) * (1.0 / _RESCALE_FACTOR)).view(1, 3, 1, 1)

	@torch.no_grad()
	def predict(self, tiles: np.ndarray) -> np.ndarray:
		"""Tree confidence for a (N, bands, H, W) uint8 batch as (N, H, W) uint8."""
		pixels = torch.from_numpy(tiles[:, :3]).to(self.device, dtype=torch.float32)
		pixels = pixels.sub_(self._mean).div_(self._std)
		# fp16 on the GPU is ~1.7x faster; against the fp32 container output it keeps ~99%
		# of confidence values identical, >99.99% within one uint8 step, and the tree mask
		# at IoU >= 0.9999 on the validation orthos.
		half = self.device.type == 'cuda'
		with torch.autocast(device_type=self.device.type, dtype=torch.float16, enabled=half):
			logits = self.model(pixel_values=pixels).logits
			probabilities = torch.nn.functional.interpolate(
				logits, size=pixels.shape[-2:], mode='bilinear', align_corners=False
			).softmax(dim=1)
		return (255 * probabilities[:, TCD_TREE_CLASS]).to(torch.uint8).cpu().numpy()

	def close(self) -> None:
		del self.model
		if self.device.type == 'cuda':
			torch.cuda.empty_cache()


def _read_tiles(src, windows: list[Window]) -> Iterator[tuple[Window, np.ndarray | None]]:
	"""Yield (window, tile) in order, reading on a background thread; empty tiles yield None."""
	buffer: queue.Queue = queue.Queue(maxsize=TCD_PREFETCH_TILES)
	stop = threading.Event()
	done = object()

	def reader():
		try:
			for window in windows:
				if stop.is_set():
					return
				tile = src.read(window=window, boundless=True)
				buffer.put((window, None if is_empty_tile(tile) else tile))
			buffer.put(done)
		except BaseException as exc:  # surfaced on the consumer thread
			buffer.put(exc)

	thread = threading.Thread(target=reader, name='tcd-tile-reader', daemon=True)
	thread.start()
	try:
		while (item := buffer.get()) is not done:
			if isinstance(item, BaseException):
				raise item
			yield item
	finally:
		stop.set()
		while thread.is_alive():
			try:
				buffer.get_nowait()
			except queue.Empty:
				thread.join(timeout=0.1)


def _batches(tiles: Iterator[tuple[Window, np.ndarray | None]], size: int):
	batch: list[tuple[Window, np.ndarray]] = []
	for window, tile in tiles:
		if tile is None:
			continue
		batch.append((window, tile))
		if len(batch) == size:
			yield batch
			batch = []
	if batch:
		yield batch


def predict_confidence_map(
	input_tif: str | os.PathLike,
	output_tif: str | os.PathLike,
	model: TCDModel,
	batch_size: int = TCD_BATCH_SIZE,
) -> TileResult:
	"""Write the uint8 tree confidence map for ``input_tif`` to ``output_tif``.

	The output is a single-band raster on the input grid with nodata 0, so skipped
	tiles and untouched pixels read as masked, like the pipeline's cache VRT.
	"""
	with rasterio.open(input_tif) as src:
		if round(TCD_GSD_M / src.res[0], 6) != 1:
			raise ValueError(f'TCD input must be at {TCD_GSD_M} m GSD, got {src.res[0]}')

		width, height = src.width, src.height
		windows = tile_windows(width, height)
		# Uncompressed so overlapping tile writes stay cheap; the file only lives for the stage.
		profile = dict(
			driver='GTiff', width=width, height=height, count=1, dtype='uint8', crs=src.crs,
			transform=src.transform, nodata=0, tiled=True, blockxsize=512, blockysize=512, BIGTIFF='IF_SAFER',
		)
		processed = 0
		with rasterio.open(output_tif, 'w', **profile) as dst:
			for batch in _batches(_read_tiles(src, windows), batch_size):
				confidence = model.predict(np.stack([tile for _, tile in batch]))
				for (window, _), tile_confidence in zip(batch, confidence):
					dst_window, rows, cols = interior_window(window, width, height)
					dst.write(tile_confidence[rows, cols], 1, window=dst_window)
				processed += len(batch)

	return TileResult(processed_tiles=processed, skipped_tiles=len(windows) - processed, device=model.device.type)
