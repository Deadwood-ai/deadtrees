import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from processor.src.utils.inference_dataset import InferenceDataset, get_windows

pytestmark = pytest.mark.unit

TILE_SIZE = 64
PADDING = 16  # 32 px output windows inside 64 px padded input windows


def _open_raster(tmp_path, alpha: np.ndarray):
	height, width = alpha.shape
	data = np.full((4, height, width), 120, dtype=np.uint8)
	data[3] = alpha
	path = tmp_path / 'ortho.tif'
	with rasterio.open(
		path, 'w', driver='GTiff', width=width, height=height, count=4, dtype='uint8',
		crs='EPSG:32632', transform=from_origin(500000.0, 5000000.0, 0.05, 0.05), photometric='RGB', alpha='YES',
	) as dst:
		dst.write(data)
	return rasterio.open(path)


def _every_window(width, height):
	step = TILE_SIZE - 2 * PADDING
	return [
		(w.col_off, w.row_off)
		for w in get_windows(-PADDING, -PADDING, width + PADDING, height + PADDING, step, step, overlap=0)
	]


def test_fully_valid_raster_keeps_every_tile(tmp_path):
	with _open_raster(tmp_path, np.full((100, 70), 255, dtype=np.uint8)) as src:
		kept = [
			(w.col_off, w.row_off)
			for w in InferenceDataset(src, TILE_SIZE, PADDING, skip_nodata_tiles=True).cropped_windows
		]

	assert kept == _every_window(70, 100)


def test_tiles_with_only_nodata_in_the_padded_input_are_dropped(tmp_path):
	alpha = np.zeros((128, 128), dtype=np.uint8)
	alpha[:, :40] = 255  # valid strip on the left, transparent elsewhere

	with _open_raster(tmp_path, alpha) as src:
		kept = [
			(w.col_off, w.row_off)
			for w in InferenceDataset(src, TILE_SIZE, PADDING, skip_nodata_tiles=True).cropped_windows
		]
		without_skip = [(w.col_off, w.row_off) for w in InferenceDataset(src, TILE_SIZE, PADDING).cropped_windows]

	# A padded input spans col_off - 16 .. col_off + 48 and still sees valid pixels
	# while it starts left of column 40; tiles further right only see nodata.
	expected = [(col, row) for col, row in _every_window(128, 128) if col - PADDING < 40]
	assert kept == expected
	assert {col for col, _ in kept} == {-16, 16, 48}
	assert without_skip == _every_window(128, 128)
