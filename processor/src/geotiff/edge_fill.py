"""Make black or white fill collars transparent when no nodata describes them.

Many orthos arrive as 8-bit RGB with a solid black or white collar around the
mosaic but without an alpha band, mask or nodata value; others declare one fill
value while the collar uses another. Lossy compression also leaves the collar
slightly off its nominal colour. Such collars render as frames on the map.

Detection is cheap: on a decimated read, look at the valid pixels that touch the
image edge or an already transparent area. If enough of them are near black or
near white, the collar is traced in from the edges at full resolution, the way GDAL
``nearblack`` does: along every row from both ends and along every column from the
top and the bottom, until ``NON_FILL_RUN`` consecutive non-fill pixels are met.
Interior dark or bright content is not touched because the scan stops at the first
non-collar pixels. Existing transparency (alpha, nodata or an internal mask) is
kept: the result is transparent where either says so.

RGB orthos get the collar as an internal mask written into the file in place,
merged with any nodata value or mask they already have, so the pixels are never
recompressed: ``nearblack`` rewrote a 5 GB JPEG ortho as a 25 GB DEFLATE RGBA copy
and took 30-80 minutes (DT-1380). Orthos with an alpha band still go through
``nearblack``, which merges the collar into that band.
"""

from pathlib import Path
import math
import os
import subprocess
import time
from typing import Callable

import numpy as np
import rasterio
from rasterio.enums import ColorInterp, MaskFlags, Resampling
from rasterio.windows import Window

from ..utils.decimated_read import read_decimated

SAMPLE_MAX_SIDE = 1024
NEAR = 8
MIN_FRONTIER_FILL_SHARE = 0.25
FILL_COLOURS = ('0,0,0', '255,255,255')
# nearblack reads scanlines from tiled sources; with too small a block cache it decodes
# every tile row once per scanline and a 10 GB ortho takes hours instead of minutes (DT-1380).
NEARBLACK_GDAL_CACHEMAX_MB = 2048
# Like nearblack's default ``-nb 2``: the scan inwards stops after this many consecutive
# pixels that are not fill-coloured, so isolated compression noise in the collar is passed.
NON_FILL_RUN = 2


def has_edge_fill(src: rasterio.DatasetReader) -> bool:
	"""True when a large share of the visible outline of ``src`` is near-black or near-white fill."""
	if src.count < 3 or src.dtypes[0] != 'uint8':
		return False
	scale = max(1, math.ceil(max(src.width, src.height) / SAMPLE_MAX_SIDE))
	shape = (max(1, src.height // scale), max(1, src.width // scale))
	# An alpha band is the dataset mask: read it with the colours instead of decoding the raster twice.
	alpha = src.count if src.colorinterp[-1] == ColorInterp.alpha and MaskFlags.alpha in src.mask_flag_enums[0] else None
	indexes = [1, 2, 3] + ([alpha] if alpha else [])
	data = read_decimated(
		src.name,
		*shape,
		lambda part, window, out: part.read(indexes, window=window, out_shape=(len(indexes), *out), resampling=Resampling.nearest),
	)
	rgb = data[:3]
	if alpha:
		valid = data[3] > 0
	else:
		valid = (
			read_decimated(
				src.name,
				*shape,
				lambda part, window, out: part.dataset_mask(window=window, out_shape=out, resampling=Resampling.nearest),
			)
			> 0
		)

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
		# With no alpha, nodata or mask yet, the collar can go into a new internal mask.
		# RGB orthos get the collar written into their own internal mask, merged with any nodata
		# value or mask they already have; only an alpha band needs the nearblack rewrite.
		in_place = src.count == 3 and not any(MaskFlags.alpha in flags for flags in src.mask_flag_enums)

	if in_place:
		started = time.monotonic()
		_write_collar_mask(path)
		progress(f'Collar mask written in place in {time.monotonic() - started:.0f} s')
		return True

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


def _fill_pixels(rgb: np.ndarray) -> np.ndarray:
	"""Pixels within NEAR of black or of white in all three bands."""
	return (rgb <= NEAR).all(axis=0) | (rgb >= 255 - NEAR).all(axis=0)


def _run_starts(non_fill: np.ndarray, axis: int) -> np.ndarray:
	"""Along ``axis``, True where a run of NON_FILL_RUN non-fill pixels starts."""
	length = non_fill.shape[axis] - NON_FILL_RUN + 1
	if length < 1:
		shape = list(non_fill.shape)
		shape[axis] = 0
		return np.zeros(shape, dtype=bool)
	starts = non_fill.take(range(0, length), axis=axis)
	for offset in range(1, NON_FILL_RUN):
		starts &= non_fill.take(range(offset, offset + length), axis=axis)
	return starts


def _first_and_last(starts: np.ndarray, axis: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
	"""Along ``axis``: whether any run starts, the first start and the last start."""
	found = starts.any(axis=axis)
	if starts.shape[axis] == 0:
		none = np.zeros(found.shape, dtype=np.int64)
		return found, none, none
	first = starts.argmax(axis=axis)
	last = starts.shape[axis] - 1 - np.flip(starts, axis=axis).argmax(axis=axis)
	return found, first, last


def _collar_extents(dataset, rows: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
	"""Per row the first and the end column, per column the first and the end row, that are not collar.

	A scan from an edge stops at the first run of NON_FILL_RUN non-fill pixels; the scan from
	the opposite edge stops at the last such run. One pass over the RGB bands yields all four.
	"""
	width, height = dataset.width, dataset.height
	left = np.empty(height, dtype=np.int64)
	right = np.empty(height, dtype=np.int64)
	top_depth = np.full(width, height, dtype=np.int64)
	bottom_end = np.zeros(width, dtype=np.int64)
	carry = np.zeros((0, width), dtype=bool)
	for top in range(0, height, rows):
		count = min(rows, height - top)
		non_fill = ~_fill_pixels(dataset.read([1, 2, 3], window=Window(0, top, width, count)))

		found, first, last = _first_and_last(_run_starts(non_fill, axis=1), axis=1)
		left[top : top + count] = np.where(found, first, width)
		right[top : top + count] = np.where(found, last + NON_FILL_RUN, 0)

		# Runs may straddle strips, so the last NON_FILL_RUN - 1 rows are carried over.
		block = np.concatenate([carry, non_fill]) if len(carry) else non_fill
		found, first, last = _first_and_last(_run_starts(block, axis=0), axis=0)
		offset = top - len(carry)
		opened = found & (top_depth == height)
		top_depth[opened] = offset + first[opened]
		bottom_end[found] = offset + last[found] + NON_FILL_RUN
		carry = block[len(block) - (NON_FILL_RUN - 1) :]
	return left, right, top_depth, bottom_end


class PartialCollarMaskError(RuntimeError):
	"""Writing the in-place collar mask failed part way; the ortho would hide valid content."""


def _write_collar_mask(path: str) -> None:
	"""Trace the collar in from all four edges and store it as a new internal mask of ``path``.

	A scan stops at the first run of NON_FILL_RUN non-fill pixels; everything before it is
	collar. Only the per-row and per-column scan depths are kept in memory. A failure after
	the first mask strip is written raises PartialCollarMaskError: unwritten strips read as
	transparent, so the file must not be used as is.
	"""
	writing = False
	try:
		# The file is the processor's own copy, so a COG upload may lose its COG layout here;
		# the COG step rebuilds one. Without this option GDAL refuses to open a COG for update.
		with (
			rasterio.Env(GDAL_TIFF_INTERNAL_MASK=True, GDAL_NUM_THREADS='ALL_CPUS'),
			rasterio.open(path, 'r+', IGNORE_COG_LAYOUT_BREAK='YES') as dataset,
		):
			width, height = dataset.width, dataset.height
			rows = dataset.block_shapes[0][0]
			left, right, from_top, from_bottom = _collar_extents(dataset, rows)

			# Existing transparency: an internal mask is read strip by strip just before that strip
			# is overwritten; a nodata value is applied from the pixels, because once the new mask
			# exists GDAL no longer derives the mask from nodata.
			had_mask = any(MaskFlags.per_dataset in flags for flags in dataset.mask_flag_enums)
			nodata = dataset.nodata
			writing = True
			columns = np.arange(width)[None, :]
			for top in range(0, height, rows):
				count = min(rows, height - top)
				window = Window(0, top, width, count)
				row_index = np.arange(top, top + count)[:, None]
				keep = columns >= left[top : top + count, None]
				keep &= columns < right[top : top + count, None]
				keep &= row_index >= from_top[None, :]
				keep &= row_index < from_bottom[None, :]
				if had_mask:
					keep &= dataset.read_masks(1, window=window) != 0
				elif nodata is not None:  # an explicit mask overrides nodata, as in GDAL
					keep &= (dataset.read([1, 2, 3], window=window) != nodata).any(axis=0)
				dataset.write_mask(keep.view(np.uint8) * np.uint8(255), window=window)

			# Existing overviews (COG uploads) would keep the old transparency at low zoom, and the
			# COG step reuses them, so rebuild them together with their masks.
			factors = dataset.overviews(1)
			if factors:
				dataset.build_overviews(factors, Resampling.average)
	except Exception as error:
		if writing:
			raise PartialCollarMaskError(f'Collar mask only partly written: {error}') from error
		raise
