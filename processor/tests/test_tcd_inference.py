from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin
from rasterio.windows import Window

from processor.src.treecover_segmentation_oam_tcd import tcd_inference
from processor.src.treecover_segmentation_oam_tcd.tcd_inference import (
	interior_window,
	is_empty_tile,
	predict_confidence_map,
	tile_edges,
	tile_windows,
)

pytestmark = pytest.mark.unit


# Edges produced by tcd_pipeline.data.tiling.Tiler(w, h, 1024, 256, align_edges=True)
# in the retired deadtrees-tcd image (cmosig/tcd @ b8917ec).
TCD_PIPELINE_TILER_EDGES = {
	(500, 300): ([0], [0]),
	(1024, 1024): ([0], [0]),
	(1025, 700): ([0, 1], [0]),
	(1792, 1024): ([0, 768], [0]),
	(1793, 2000): ([0, 384, 769], [0, 488, 976]),
	(3000, 800): ([0, 658, 1317, 1976], [0]),
	(5831, 4326): ([0, 686, 1373, 2060, 2746, 3433, 4120, 4807], [0, 660, 1320, 1981, 2641, 3302]),
	(14702, 12062): (
		[0, 759, 1519, 2279, 3039, 3799, 4559, 5319, 6079, 6839, 7598, 8358, 9118, 9878, 10638, 11398, 12158, 12918, 13678],
		[0, 735, 1471, 2207, 2943, 3679, 4415, 5151, 5886, 6622, 7358, 8094, 8830, 9566, 10302, 11038],
	),
}


@pytest.mark.parametrize(('size', 'edges'), TCD_PIPELINE_TILER_EDGES.items())
def test_tile_edges_match_tcd_pipeline(size, edges):
	width, height = size
	x_edges, y_edges = edges

	assert tile_edges(width) == x_edges
	assert tile_edges(height) == y_edges
	windows = tile_windows(width, height)
	assert len(windows) == len(x_edges) * len(y_edges)
	# Row-major like the pipeline: y outer, x inner.
	assert [(w.col_off, w.row_off) for w in windows[: len(x_edges)]] == [(x, 0) for x in x_edges]


def test_is_empty_tile_uses_mean_over_all_bands():
	tile = np.zeros((4, 8, 8), dtype=np.uint8)
	assert is_empty_tile(tile)
	tile[:, :4] = 255
	assert not is_empty_tile(tile)
	assert is_empty_tile(np.full((4, 8, 8), 254, dtype=np.uint8))
	# RGB black with an opaque alpha band still averages above 1, so it is predicted.
	rgb_black_opaque = np.zeros((4, 8, 8), dtype=np.uint8)
	rgb_black_opaque[3] = 255
	assert not is_empty_tile(rgb_black_opaque)


def test_interior_window_trims_only_sides_facing_other_tiles():
	width, height = 3000, 800

	first, rows, cols = interior_window(Window(0, 0, 1024, 1024), width, height)
	assert (first.col_off, first.width) == (0, 1024 - 128)
	# Taller than the raster: nothing to trim vertically, clipped to the raster.
	assert (first.row_off, first.height) == (0, 800)
	assert (rows, cols) == (slice(0, 800), slice(0, 896))

	middle, _, cols = interior_window(Window(1317, 0, 1024, 1024), width, height)
	assert (middle.col_off, middle.width) == (1317 + 128, 1024 - 256)
	assert cols == slice(128, 896)

	last, _, cols = interior_window(Window(1976, 0, 1024, 1024), width, height)
	assert (last.col_off, last.col_off + last.width) == (1976 + 128, width)
	assert cols == slice(128, 1024)


def test_interior_window_single_tile_larger_than_raster():
	window, rows, cols = interior_window(Window(0, 0, 1024, 1024), 500, 300)
	assert (window.col_off, window.row_off, window.width, window.height) == (0, 0, 500, 300)
	assert (rows, cols) == (slice(0, 300), slice(0, 500))


def _write_raster(path: Path, data: np.ndarray, res: float = 0.1) -> None:
	count, height, width = data.shape
	with rasterio.open(
		path, 'w', driver='GTiff', width=width, height=height, count=count, dtype='uint8',
		crs='EPSG:3395', transform=from_origin(1000.0, 2000.0, res, res), nodata=0, tiled=True,
		blockxsize=256, blockysize=256,
	) as dst:
		dst.write(data)


class _TileIndexModel:
	"""Fake model: every pixel of the n-th predicted tile gets confidence n + 10."""

	def __init__(self):
		self.device = tcd_inference.torch.device('cpu')
		self.calls = 0
		self.batch_sizes = []

	def predict(self, tiles):
		self.batch_sizes.append(len(tiles))
		out = np.empty((len(tiles), tiles.shape[2], tiles.shape[3]), dtype=np.uint8)
		for i in range(len(tiles)):
			out[i] = self.calls + 10
			self.calls += 1
		return out


def test_predict_confidence_map_merges_tiles_like_the_pipeline(tmp_path):
	width, height = 3000, 800
	data = np.full((4, height, width), 120, dtype=np.uint8)
	# The third tile (cols 1317..2341) sees only nodata and is skipped.
	data[:, :, 1024:2341] = 0
	src = tmp_path / 'reprojected.tif'
	_write_raster(src, data)

	model = _TileIndexModel()
	out = tmp_path / 'confidence.tif'
	result = predict_confidence_map(src, out, model, batch_size=1)

	assert (result.processed_tiles, result.skipped_tiles) == (3, 1)
	with rasterio.open(out) as conf:
		assert (conf.width, conf.height, conf.count, conf.nodata) == (width, height, 1, 0)
		assert conf.transform == from_origin(1000.0, 2000.0, 0.1, 0.1)
		values = conf.read(1)

	# Tile 0 owns cols [0, 896), tile 1 (cols 658..1682) owns [786, 1554) and was written
	# after tile 0, tile 2 (the empty one) is skipped, and the last tile owns [2104, 3000).
	assert np.all(values[:, :786] == 10)
	assert np.all(values[:, 786:1554] == 11)
	assert np.all(values[:, 1554:2104] == 0)
	assert np.all(values[:, 2104:] == 12)


def test_predict_confidence_map_batches_without_changing_the_merge(tmp_path):
	data = np.random.default_rng(1).integers(30, 200, size=(3, 1900, 2100), dtype=np.uint8)
	src = tmp_path / 'reprojected.tif'
	_write_raster(src, data)

	outputs = []
	for batch_size in (1, 3):
		model = _TileIndexModel()
		out = tmp_path / f'confidence_b{batch_size}.tif'
		predict_confidence_map(src, out, model, batch_size=batch_size)
		with rasterio.open(out) as conf:
			outputs.append(conf.read(1))
		assert max(model.batch_sizes) == batch_size

	np.testing.assert_array_equal(outputs[0], outputs[1])


def test_predict_confidence_map_rejects_other_resolutions(tmp_path):
	src = tmp_path / 'reprojected.tif'
	_write_raster(src, np.full((3, 64, 64), 100, dtype=np.uint8), res=0.05)

	with pytest.raises(ValueError, match='0.1 m GSD'):
		predict_confidence_map(src, tmp_path / 'out.tif', _TileIndexModel())


def test_tile_reader_surfaces_read_errors(tmp_path):
	class _BrokenSource:
		def read(self, window, boundless):
			raise OSError('decode failed')

	with pytest.raises(OSError, match='decode failed'):
		list(tcd_inference._read_tiles(_BrokenSource(), tile_windows(2100, 1900)))


def test_resolve_model_dir_prefers_provisioned_asset(tmp_path, monkeypatch):
	for name in tcd_inference.TCD_MODEL_FILES:
		(tmp_path / name).write_text('x')
	monkeypatch.setattr(tcd_inference, 'TCD_LOCAL_MODEL_DIR', tmp_path)

	assert tcd_inference.resolve_model_dir() == tmp_path


def test_resolve_model_dir_downloads_pinned_revision_once(tmp_path, monkeypatch):
	import huggingface_hub
	from huggingface_hub.errors import LocalEntryNotFoundError

	monkeypatch.setattr(tcd_inference, 'TCD_LOCAL_MODEL_DIR', tmp_path / 'missing')
	monkeypatch.setattr(tcd_inference.settings, 'TCD_MODEL_CACHE_DIR', str(tmp_path / 'cache'))
	cached = set()
	calls = []

	def fake_snapshot_download(repo_id, revision, cache_dir, allow_patterns, local_files_only=False):
		calls.append(local_files_only)
		assert (repo_id, revision) == (tcd_inference.TCD_MODEL_REPO, tcd_inference.TCD_MODEL_REVISION)
		assert allow_patterns == list(tcd_inference.TCD_MODEL_FILES)
		if local_files_only and revision not in cached:
			raise LocalEntryNotFoundError('not cached')
		cached.add(revision)
		return str(Path(cache_dir) / 'snapshot')

	monkeypatch.setattr(huggingface_hub, 'snapshot_download', fake_snapshot_download)

	first = tcd_inference.resolve_model_dir()
	second = tcd_inference.resolve_model_dir()

	assert first == second == tmp_path / 'cache' / 'snapshot'
	# First call misses the cache and downloads; the second is served locally.
	assert calls == [True, False, True]
