import numpy as np
import pytest
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_origin

from processor.src.utils.decimated_read import read_decimated

pytestmark = pytest.mark.unit


def _write_rgba(path, height, width, overviews=()):
	rng = np.random.default_rng(7)
	data = rng.integers(0, 256, size=(4, height, width), dtype=np.uint8)
	data[3, : height // 3, : width // 4] = 0
	with rasterio.open(
		path, 'w', driver='GTiff', width=width, height=height, count=4, dtype='uint8', tiled=True,
		blockxsize=128, blockysize=128, compress='deflate', crs='EPSG:32632',
		transform=from_origin(500000.0, 5000000.0, 0.05, 0.05), photometric='RGB', alpha='YES',
	) as dst:
		dst.write(data)
		if overviews:
			dst.build_overviews(list(overviews), Resampling.average)
	return path


def _bands(src, window, shape):
	return src.read(window=window, out_shape=(src.count, *shape), resampling=Resampling.nearest)


def _mask(src, window, shape):
	return src.dataset_mask(window=window, out_shape=shape, resampling=Resampling.nearest)


@pytest.mark.parametrize('overviews', [(), (2, 4)])
@pytest.mark.parametrize('out_shape', [(256, 181), (37, 1000), (1, 1), (1700, 1100)])
def test_split_read_samples_the_same_pixels_as_one_read(tmp_path, overviews, out_shape):
	path = str(_write_rgba(tmp_path / 'ortho.tif', 1400, 990, overviews))
	with rasterio.open(path) as src:
		bands = src.read(out_shape=(src.count, *out_shape), resampling=Resampling.nearest)
		mask = src.dataset_mask(out_shape=out_shape, resampling=Resampling.nearest)

	assert np.array_equal(read_decimated(path, *out_shape, _bands, threads=3), bands)
	assert np.array_equal(read_decimated(path, *out_shape, _mask, threads=5), mask)
