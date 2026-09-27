import numpy as np
import pytest
import rasterio
import torch
from rasterio.transform import from_origin
from rasterio.windows import Window

from processor.src.utils.inference_dataset import InferenceDataset, clip_to_raster, get_windows, predict_tiles

pytestmark = pytest.mark.unit

TILE_SIZE = 64
PADDING = 16  # 32 px output windows inside 64 px padded input windows


def _write_raster(tmp_path, alpha: np.ndarray, rgb: np.ndarray | None = None):
	height, width = alpha.shape
	data = np.full((4, height, width), 120, dtype=np.uint8)
	if rgb is not None:
		data[:3] = rgb
	data[3] = alpha
	path = tmp_path / 'ortho.tif'
	with rasterio.open(
		path, 'w', driver='GTiff', width=width, height=height, count=4, dtype='uint8',
		crs='EPSG:32632', transform=from_origin(500000.0, 5000000.0, 0.05, 0.05), photometric='RGB', alpha='YES',
	) as dst:
		dst.write(data)
	return path


def _dataset(path, **kwargs):
	return InferenceDataset(lambda: rasterio.open(path), TILE_SIZE, PADDING, **kwargs)


def _every_window(width, height):
	step = TILE_SIZE - 2 * PADDING
	return [
		(w.col_off, w.row_off)
		for w in get_windows(-PADDING, -PADDING, width + PADDING, height + PADDING, step, step, overlap=0)
	]


def _tile_origins(dataset):
	# Output windows are clipped to the raster; map them back to their unclipped origin.
	return [
		(int(t.out_window.col_off) - t.cols.start, int(t.out_window.row_off) - t.rows.start)
		for t in dataset.tiles()
	]


def test_fully_valid_raster_keeps_every_tile_in_window_order(tmp_path):
	path = _write_raster(tmp_path, np.full((100, 70), 255, dtype=np.uint8))

	assert _tile_origins(_dataset(path, skip_nodata_tiles=True, reader_threads=3)) == _every_window(70, 100)


def test_tiles_with_only_nodata_in_the_padded_input_are_dropped(tmp_path):
	alpha = np.zeros((128, 128), dtype=np.uint8)
	alpha[:, :40] = 255  # valid strip on the left, transparent elsewhere
	path = _write_raster(tmp_path, alpha)

	kept = _tile_origins(_dataset(path, skip_nodata_tiles=True))
	without_skip = _tile_origins(_dataset(path))

	# A padded input spans col_off - 16 .. col_off + 48 and still sees valid pixels
	# while it starts left of column 40; tiles further right only see nodata.
	expected = [(col, row) for col, row in _every_window(128, 128) if col - PADDING < 40]
	assert kept == expected
	assert {col for col, _ in kept} == {-16, 16, 48}
	assert without_skip == _every_window(128, 128)


def test_predict_tiles_reassembles_the_raster_and_zeroes_nodata(tmp_path):
	rng = np.random.default_rng(0)
	rgb = rng.integers(0, 256, size=(3, 90, 75), dtype=np.uint8)
	alpha = np.full((90, 75), 255, dtype=np.uint8)
	alpha[60:, 50:] = 0
	path = _write_raster(tmp_path, alpha, rgb)

	# Identity "model": the class of each pixel is its red value, so the output must
	# reproduce the red band exactly, with nodata pixels set to 0.
	out = np.full((90, 75), 7, dtype=np.uint8)
	dataset = _dataset(path, reader_threads=2)
	for window, tile in predict_tiles(dataset, lambda images: images[:, 0], torch.device('cpu'), batch_size=3):
		out[window.toslices()] = tile

	expected = rgb[0].copy()
	expected[alpha == 0] = 0
	np.testing.assert_array_equal(out, expected)


def test_reader_errors_surface_on_the_consumer(tmp_path):
	path = _write_raster(tmp_path, np.full((64, 64), 255, dtype=np.uint8))
	dataset = _dataset(path)

	def broken_read(*_args, **_kwargs):
		raise OSError('boom')

	dataset._read_tile = broken_read
	with pytest.raises(OSError, match='boom'):
		list(dataset.tiles())


def test_clip_to_raster_keeps_a_window_inside_the_raster():
	out_window, rows, cols = clip_to_raster(Window(10, 20, 100, 40), width=200, height=200)

	assert out_window == Window(10, 20, 100, 40)
	assert rows == slice(0, 40)
	assert cols == slice(0, 100)


def test_clip_to_raster_trims_raster_edges_independently():
	out_window, rows, cols = clip_to_raster(Window(-5, 170, 100, 40), width=80, height=200)

	assert out_window == Window(0, 170, 80, 30)
	assert rows == slice(0, 30)
	assert cols == slice(5, 85)


def test_clip_to_raster_rejects_a_window_off_the_raster():
	assert clip_to_raster(Window(-40, 0, 32, 32), width=80, height=80) == (None, None, None)
