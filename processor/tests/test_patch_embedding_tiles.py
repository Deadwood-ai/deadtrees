"""Embedding tiles read on several threads are the tiles, in the order, one reader gives."""

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from processor.src.embedding_search import patch_embedding
from processor.src.utils.segmentation import image_reprojector

pytestmark = pytest.mark.unit


def _ortho(tmp_path):
	rng = np.random.default_rng(11)
	height, width = 1300, 1150
	data = rng.integers(0, 256, size=(4, height, width), dtype=np.uint8)
	data[3] = 255
	data[3, :, :300] = 0  # tiles touching this strip are mostly nodata and skipped
	data[:3, 600:, 600:] = 90  # one flat colour: skipped as single-coloured
	path = tmp_path / 'ortho.tif'
	with rasterio.open(
		path, 'w', driver='GTiff', width=width, height=height, count=4, dtype='uint8', crs='EPSG:32632',
		transform=from_origin(500000.0, 5300000.0, 0.1, 0.1), photometric='RGB', alpha='YES',
	) as dst:
		dst.write(data)
	return str(path)


def _tiles(path, reader_threads):
	def open_vrt():
		return image_reprojector(path, min_res=patch_embedding.GSD_M, max_res=patch_embedding.GSD_M)

	return [
		(np.asarray(image).tobytes(), meta.pixel_bbox, meta.geo_bbox_4326, meta.nodata_fraction)
		for image, meta in patch_embedding._iter_tiles(open_vrt, reader_threads=reader_threads)
	]


def test_parallel_tile_reads_keep_the_tiles_and_their_order(tmp_path):
	path = _ortho(tmp_path)

	single = _tiles(path, reader_threads=1)

	assert 0 < len(single) < 9
	assert [bbox for _, bbox, _, _ in single] == sorted((bbox for _, bbox, _, _ in single), key=lambda b: (b[1], b[0]))
	assert _tiles(path, reader_threads=3) == single
