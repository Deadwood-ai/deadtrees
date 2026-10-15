"""Decimated whole-raster reads split across threads.

Without overviews, a decimated read decodes every block of the raster, and GDAL does
that on one thread. When the decoded raster is larger than the block cache, a
pixel-interleaved file is decoded once per band as well: the 256 px thumbnail of a
2.2 GB RGBA ortho took 77 s. Reading horizontal bands of the output on separate
handles decodes each block about once and spreads the work: 17 s on 4 threads.

The bands are floating-point source windows, so GDAL samples exactly the source
pixels of the single full read and the result is identical.
"""

from concurrent.futures import ThreadPoolExecutor
from typing import Callable

import numpy as np
import rasterio
from rasterio.windows import Window

DECIMATED_READ_THREADS = 8


def read_decimated(
	path: str,
	out_height: int,
	out_width: int,
	read: Callable[[rasterio.DatasetReader, Window, tuple[int, int]], np.ndarray],
	threads: int = DECIMATED_READ_THREADS,
) -> np.ndarray:
	"""Read the whole raster at ``path`` into ``out_height`` x ``out_width``.

	``read(src, window, (rows, out_width))`` reads one band of output rows from its own
	handle, for example ``src.read(window=window, out_shape=(src.count, *shape))``. The
	parts are joined along the row axis (the second to last).
	"""
	with rasterio.open(path) as src:
		height, width = src.height, src.width
	edges = np.linspace(0, out_height, max(1, min(threads, out_height)) + 1).round().astype(int)
	parts = [(int(top), int(bottom)) for top, bottom in zip(edges[:-1], edges[1:]) if bottom > top]
	scale = height / out_height

	def read_part(part):
		top, bottom = part
		window = Window(0, top * scale, width, (bottom - top) * scale)
		with rasterio.open(path) as src:
			return read(src, window, (bottom - top, out_width))

	with ThreadPoolExecutor(max_workers=len(parts), thread_name_prefix='decimated-read') as pool:
		return np.concatenate(list(pool.map(read_part, parts)), axis=-2)
