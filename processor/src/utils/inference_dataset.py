"""Padded, overlap-aware tiling and batched GPU prediction over a reprojected ortho.

Shared by the deadwood, combined deadwood+treecover and AOI models. Every tile is a
``tile_size`` input window around a ``tile_size - 2 * padding`` output window; only
the output window of each prediction is kept.
"""

import threading
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Callable, Iterator

import numpy as np
import torch
from rasterio import windows
from tqdm import tqdm

from .nodata import read_nodata_mask, share_padding_map

# Warped window reads are the CPU bottleneck (~85 ms per 1024 px tile, not sped up by
# GDAL_NUM_THREADS) and scale almost linearly over threads that each own a handle:
# 4 readers bring it to ~36 ms per tile, below the fp16 model time.
READER_THREADS = 4
IMAGENET_MEAN = (0.485, 0.456, 0.406)
IMAGENET_STD = (0.229, 0.224, 0.225)


@dataclass
class Tile:
	out_window: windows.Window  # output window clipped to the raster
	rows: slice  # rows/cols of the clipped output window within the tile interior
	cols: slice
	image: np.ndarray  # (3, tile_size, tile_size) uint8 input, zero-padded off the raster
	nodata: np.ndarray  # (out_window.height, out_window.width) bool, True = nodata


class InferenceDataset:
	"""Tiles of the raster ``open_image()`` returns, read ahead on background threads.

	``open_image`` must return a fresh handle per call (GDAL handles cannot be shared
	across threads), each describing the same raster.
	"""

	def __init__(
		self,
		open_image: Callable,
		tile_size=512,
		padding=56,
		skip_nodata_tiles=False,
		reader_threads=READER_THREADS,
	):
		self.tile_size = tile_size
		self.padding = padding
		self.skip_nodata_tiles = skip_nodata_tiles
		self.reader_threads = reader_threads
		self._open_image = open_image
		self.image_src = open_image()
		self.width = self.image_src.width
		self.height = self.image_src.height

		self.cropped_windows = list(
			get_windows(
				xmin=-self.padding,
				ymin=-self.padding,
				xmax=self.width + self.padding,
				ymax=self.height + self.padding,
				tile_width=self.tile_size - (padding * 2),
				tile_height=self.tile_size - (padding * 2),
				overlap=0,
			)
		)

	def __len__(self):
		return len(self.cropped_windows)

	def tiles(self) -> Iterator[Tile]:
		"""Yield tiles in window order, reading up to ``2 * reader_threads`` tiles ahead.

		With ``skip_nodata_tiles``, tiles whose whole padded input is nodata are left
		out: callers start from an all-zero output and zero nodata anyway, so predicting
		them only costs GPU time. Order is kept so overlapping edge tiles are written in
		the same order on every run.
		"""
		local = threading.local()
		handles = []
		handles_lock = threading.Lock()

		def read(cropped_window):
			if not hasattr(local, 'src'):
				local.src = self._open_image()
				with handles_lock:
					handles.append(local.src)
					# Metadata-less orthos need a raster-wide fill scan; do it once.
					share_padding_map(self.image_src, local.src)
			return self._read_tile(local.src, cropped_window)

		pending = deque()
		try:
			with ThreadPoolExecutor(max_workers=self.reader_threads, thread_name_prefix='tile-reader') as pool:
				try:
					for cropped_window in self.cropped_windows:
						pending.append(pool.submit(read, cropped_window))
						if len(pending) >= 2 * self.reader_threads:
							if (tile := pending.popleft().result()) is not None:
								yield tile
					while pending:
						if (tile := pending.popleft().result()) is not None:
							yield tile
				finally:
					for future in pending:
						future.cancel()
		finally:
			for src in handles:
				src.close()

	def _read_tile(self, src, cropped_window) -> Tile | None:
		inference_window = self._inference_window(cropped_window)
		raster = windows.Window(0, 0, self.width, self.height)
		if self.skip_nodata_tiles and read_nodata_mask(src, windows.intersection(inference_window, raster)).all():
			return None

		out_window, rows, cols = clip_to_raster(cropped_window, self.width, self.height)
		if out_window is None:
			return None

		try:
			image = src.read((1, 2, 3), window=inference_window)
		except Exception as e:
			raise RuntimeError(
				f'Raster read failed at window {cropped_window} (inference_window={inference_window}): {e}'
			) from e

		if image.shape[1] < self.tile_size or image.shape[2] < self.tile_size:
			pad_left = 0 if inference_window.col_off >= 0 else abs(inference_window.col_off)
			pad_right = self.tile_size - (pad_left + image.shape[2])
			pad_top = 0 if inference_window.row_off >= 0 else abs(inference_window.row_off)
			pad_bottom = self.tile_size - (pad_top + image.shape[1])

			image = np.pad(
				image,
				((0, 0), (pad_top, pad_bottom), (pad_left, pad_right)),
				mode='constant',
				constant_values=0,
			)

		return Tile(out_window, rows, cols, image, read_nodata_mask(src, out_window))

	def _inference_window(self, cropped_window):
		return windows.Window(
			cropped_window.col_off - self.padding,
			cropped_window.row_off - self.padding,
			cropped_window.width + (2 * self.padding),
			cropped_window.height + (2 * self.padding),
		)


def predict_tiles(
	dataset: InferenceDataset,
	predict: Callable[[torch.Tensor], torch.Tensor],
	device: torch.device,
	batch_size: int,
	desc: str = 'inference',
) -> Iterator[tuple[windows.Window, np.ndarray]]:
	"""Yield ``(out_window, uint8 class tile)`` for every predicted tile.

	``predict`` maps a (B, 3, H, W) uint8 batch on ``device`` to a (B, H, W) uint8
	class map. Nodata pixels of each output window are set to class 0.
	"""
	interior = slice(dataset.padding, dataset.tile_size - dataset.padding)
	batch: list[Tile] = []

	def flush():
		images = torch.from_numpy(np.stack([tile.image for tile in batch])).to(device)
		with torch.no_grad():
			classes = predict(images)[:, interior, interior].cpu().numpy()
		for tile, tile_classes in zip(batch, classes):
			out = tile_classes[tile.rows, tile.cols].copy()
			out[tile.nodata] = 0
			yield tile.out_window, out
		batch.clear()

	with tqdm(desc=desc, unit='tile') as progress:
		for tile in dataset.tiles():
			batch.append(tile)
			if len(batch) == batch_size:
				progress.update(len(batch))
				yield from flush()
		if batch:
			progress.update(len(batch))
			yield from flush()


def normalize_imagenet(images: torch.Tensor, dtype: torch.dtype) -> torch.Tensor:
	"""uint8 (B, 3, H, W) -> ImageNet-normalized ``dtype`` tensor on the same device."""
	mean = torch.tensor(IMAGENET_MEAN, device=images.device).view(1, 3, 1, 1)
	std = torch.tensor(IMAGENET_STD, device=images.device).view(1, 3, 1, 1)
	return ((images.float() / 255.0 - mean) / std).to(dtype)


def clip_to_raster(cropped_window, width: int, height: int):
	"""Clip an output window to the raster.

	Returns ``(window, rows, cols)`` where ``rows``/``cols`` select the clipped part
	within the unclipped window, or ``(None, None, None)`` if none of it is on the raster.
	"""
	minx = int(cropped_window.col_off)
	miny = int(cropped_window.row_off)
	maxx = minx + int(cropped_window.width)
	maxy = miny + int(cropped_window.height)

	clipped_minx, clipped_miny = max(0, minx), max(0, miny)
	clipped_maxx, clipped_maxy = min(maxx, width), min(maxy, height)
	if clipped_maxx <= clipped_minx or clipped_maxy <= clipped_miny:
		return None, None, None

	out_window = windows.Window(
		col_off=clipped_minx,
		row_off=clipped_miny,
		width=clipped_maxx - clipped_minx,
		height=clipped_maxy - clipped_miny,
	)
	rows = slice(clipped_miny - miny, clipped_maxy - miny)
	cols = slice(clipped_minx - minx, clipped_maxx - minx)
	return out_window, rows, cols


def get_windows(xmin, ymin, xmax, ymax, tile_width, tile_height, overlap):
	xstep = tile_width - overlap
	ystep = tile_height - overlap
	for x in range(xmin, xmax, xstep):
		if x + tile_width > xmax:
			x = xmax - tile_width
		for y in range(ymin, ymax, ystep):
			if y + tile_height > ymax:
				y = ymax - tile_height
			yield windows.Window(x, y, tile_width, tile_height)
