"""Make black or white fill collars transparent when no nodata describes them.

Many orthos arrive as 8-bit RGB with a solid black or white collar around the
mosaic but without an alpha band, mask or nodata value; others declare one fill
value while the collar uses another. Lossy compression also leaves the collar
slightly off its nominal colour. Such collars render as frames on the map.

Detection is cheap: on a decimated read, look at the valid pixels that touch the
image edge or an already transparent area. If enough of them are near black or
near white, GDAL ``nearblack`` scans in from the edges at full resolution and
writes an alpha band. Interior dark or bright content is not touched because
the scan stops at the first non-collar pixels. Existing transparency (alpha,
nodata or an internal mask) is kept: the result is transparent where either
says so.
"""

from pathlib import Path
import math
import os
import subprocess
import time
from typing import Callable

import numpy as np
import rasterio
from rasterio.enums import ColorInterp, Resampling

SAMPLE_MAX_SIDE = 1024
NEAR = 8
MIN_FRONTIER_FILL_SHARE = 0.25
FILL_COLOURS = ('0,0,0', '255,255,255')
# nearblack reads scanlines from tiled sources; with too small a block cache it decodes
# every tile row once per scanline and a 10 GB ortho takes hours instead of minutes (DT-1380).
NEARBLACK_GDAL_CACHEMAX_MB = 2048


def has_edge_fill(src: rasterio.DatasetReader) -> bool:
	"""True when a large share of the visible outline of ``src`` is near-black or near-white fill."""
	if src.count < 3 or src.dtypes[0] != 'uint8':
		return False
	scale = max(1, math.ceil(max(src.width, src.height) / SAMPLE_MAX_SIDE))
	shape = (max(1, src.height // scale), max(1, src.width // scale))
	rgb = src.read([1, 2, 3], out_shape=(3, *shape), resampling=Resampling.nearest)
	valid = src.dataset_mask(out_shape=shape, resampling=Resampling.nearest) > 0

	frontier = valid & ~_interior(valid)
	if not frontier.any():
		return False
	near_fill = (rgb <= NEAR).all(axis=0) | (rgb >= 255 - NEAR).all(axis=0)
	return float(near_fill[frontier].mean()) >= MIN_FRONTIER_FILL_SHARE


def mask_edge_fill(path: str, progress: Callable[[str], None] = print) -> bool:
	"""Rewrite ``path`` with its edge fill collar transparent. Returns True when it changed the file.

	``progress`` receives the duration of each step; on large orthos they can take hours.
	"""
	started = time.monotonic()
	with rasterio.open(path) as src:
		found = has_edge_fill(src)
		progress(f'Edge fill detection took {time.monotonic() - started:.0f} s: {"collar found" if found else "no collar"}')
		if not found:
			return False
		existing_alpha = src.count if src.colorinterp[-1] == ColorInterp.alpha else None
		if src.count != (4 if existing_alpha else 3):
			return False

	masked = f'{path}.edgefill.tif'
	command = ['nearblack', '-q', '-of', 'GTiff', '-setalpha', '-near', str(NEAR)]
	for colour in FILL_COLOURS:
		command.extend(['-color', colour])
	for option in ('TILED=YES', 'COMPRESS=DEFLATE', 'PREDICTOR=2', 'BIGTIFF=IF_SAFER'):
		command.extend(['-co', option])
	command.extend(['-o', masked, path])
	try:
		started = time.monotonic()
		subprocess.run(
			command,
			check=True,
			capture_output=True,
			text=True,
			env={**os.environ, 'GDAL_CACHEMAX': str(NEARBLACK_GDAL_CACHEMAX_MB)},
		)
		progress(f'nearblack took {time.monotonic() - started:.0f} s; merging existing transparency')
		started = time.monotonic()
		_keep_existing_transparency(path, masked)
		progress(f'Transparency merge took {time.monotonic() - started:.0f} s')
		Path(masked).replace(path)
	finally:
		Path(masked).unlink(missing_ok=True)
	return True


def _interior(valid: np.ndarray) -> np.ndarray:
	"""Valid pixels whose four neighbours are valid and inside the image."""
	interior = valid.copy()
	interior[0, :] = interior[-1, :] = False
	interior[:, 0] = interior[:, -1] = False
	interior[1:, :] &= valid[:-1, :]
	interior[:-1, :] &= valid[1:, :]
	interior[:, 1:] &= valid[:, :-1]
	interior[:, :-1] &= valid[:, 1:]
	return interior


def _keep_existing_transparency(source_path: str, masked_path: str) -> None:
	"""nearblack drops nodata and masks; keep every pixel the source already hid (alpha, nodata or mask)."""
	with rasterio.open(source_path) as source, rasterio.open(masked_path, 'r+') as masked:
		for _, window in masked.block_windows(4):
			alpha = np.minimum(masked.read(4, window=window), source.dataset_mask(window=window))
			masked.write(alpha, 4, window=window)
