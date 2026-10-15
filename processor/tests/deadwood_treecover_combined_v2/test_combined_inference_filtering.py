import pytest
from rasterio.crs import CRS
from shapely.geometry import Point, Polygon

pytest.importorskip('safetensors')
pytest.importorskip('torch')
pytest.importorskip('torchvision')
pytest.importorskip('transformers')

pytestmark = pytest.mark.unit

from processor.src.deadwood_treecover_combined_v2.inference import combined_inference
from processor.src.deadwood_treecover_combined_v2.inference.combined_inference import CombinedInference
from processor.src.utils.geometry_validation import RINGWISE_REPAIR_MIN_HOLES, repair_polygon


def _num_points(polygon):
	return len(polygon.exterior.coords) + sum(len(r.coords) for r in polygon.interiors)


def test_filter_polygons_simplifies(monkeypatch):
	"""_filter_polygons applies VW simplification + Chaikin smoothing: vertex counts
	drop while the feature is preserved and reprojected."""
	# Dense circle (~1024 vertices, ~6cm spacing) so VW 0.0625m² reduces it.
	polygon = Point(0, 0).buffer(10, quad_segs=256)
	inference_crs = CRS.from_epsg(32634)
	orig_crs = CRS.from_epsg(4326)

	reproject_call = {}

	def fake_reproject_polygons(polygons, src_crs, dst_crs):
		reproject_call['src_crs'] = src_crs
		reproject_call['dst_crs'] = dst_crs
		return polygons

	monkeypatch.setattr(combined_inference, 'reproject_polygons', fake_reproject_polygons)

	inference = CombinedInference.__new__(CombinedInference)
	result = inference._filter_polygons([polygon], inference_crs, orig_crs)

	assert len(result) == 1
	# Simplification removed redundant vertices despite the Chaikin pass.
	assert _num_points(result[0]) < _num_points(polygon)
	# Simplify happens in the metric inference CRS, then reprojection to the original CRS.
	assert reproject_call['src_crs'] == inference_crs
	assert reproject_call['dst_crs'] == orig_crs


def test_filter_polygons_preserves_feature_count_when_vw_is_aggressive(monkeypatch):
	"""Even with an area threshold far larger than the polygon, the feature is never
	silently dropped (it falls back to the original on collapse)."""
	polygon = Point(0, 0).buffer(10, quad_segs=128)

	monkeypatch.setattr(combined_inference, 'reproject_polygons', lambda polys, s, d: polys)
	monkeypatch.setattr(combined_inference, 'VW_AREA_THRESHOLD', 1e6)

	inference = CombinedInference.__new__(CombinedInference)
	result = inference._filter_polygons([polygon], CRS.from_epsg(32634), CRS.from_epsg(4326))

	assert len(result) == 1
	assert not result[0].is_empty


def test_simplify_and_smooth_preserves_holes():
	"""A polygon with a sizeable hole keeps its hole through VW + Chaikin."""
	exterior = Point(0, 0).buffer(10, quad_segs=128)
	hole = Point(0, 0).buffer(3, quad_segs=128)
	polygon = Polygon(exterior.exterior.coords, [hole.exterior.coords])

	result = combined_inference._simplify_and_smooth(polygon)

	assert len(result) == 1
	assert len(result[0].interiors) == 1
	assert result[0].is_valid


def test_simplify_and_smooth_returns_polygons():
	"""Output geometries are always Polygons (never Multi*), matching the
	one-Polygon-in / list-of-Polygons-out contract downstream relies on."""
	polygon = Point(0, 0).buffer(10, quad_segs=256)

	result = combined_inference._simplify_and_smooth(polygon)

	assert result
	assert all(g.geom_type == 'Polygon' and not g.is_empty for g in result)


def test_polygons_from_mask_reports_each_step(monkeypatch, tmp_path):
	"""Long post-processing on dense forest reports its progress (DT-1379)."""
	import numpy as np
	import rasterio
	from rasterio.transform import from_origin

	mask = np.zeros((40, 40), dtype=np.uint8)
	mask[5:35, 5:35] = 1
	mask[15:20, 15:20] = 0  # one hole
	path = tmp_path / 'mask.tif'
	with rasterio.open(
		path, 'w', driver='GTiff', height=40, width=40, count=1, dtype='uint8',
		crs='EPSG:32634', transform=from_origin(500000, 5000000, 1, 1),
	) as dst:
		dst.write(mask, 1)
	monkeypatch.setattr(combined_inference, 'reproject_polygons', lambda polygons, src, dst: polygons)
	messages = []

	inference = CombinedInference.__new__(CombinedInference)
	polygons = inference._polygons_from_mask(
		str(path), 1, 'treecover', CRS.from_epsg(32634), CRS.from_epsg(4326), messages.append
	)

	assert len(polygons) == 1
	assert messages[0].startswith('Polygonized treecover: 1 polygons, up to 1 holes in one')
	assert messages[1].startswith('Simplified treecover to 1 polygons')


def _forest_with_holes(count):
	side = int(count**0.5) + 1
	holes = []
	for i in range(side):
		for j in range(side):
			if len(holes) == count:
				break
			x, y = i * 0.7, j * 0.7
			# Staircase holes whose smoothed outlines overlap their diagonal neighbours.
			holes.append([(x + 0.1, y + 0.1), (x + 0.4, y + 0.1), (x + 0.4, y + 0.25), (x + 0.5, y + 0.25), (x + 0.5, y + 0.5), (x + 0.1, y + 0.5)])
	return Polygon([(0, 0), (side * 0.7, 0), (side * 0.7, side * 0.7), (0, side * 0.7)], holes)


def test_many_hole_repair_matches_buffer0():
	"""Ring-by-ring repair of a forest polygon with many holes gives buffer(0)'s area (DT-1379)."""
	polygon = _forest_with_holes(RINGWISE_REPAIR_MIN_HOLES + 500)
	shell = _chaikin_coords(polygon.exterior)
	holes = [_chaikin_coords(ring) for ring in polygon.interiors]
	assert not Polygon(shell, holes).is_valid

	repaired = repair_polygon(Polygon(shell, holes))

	expected = Polygon(shell, holes).buffer(0)
	assert repaired.is_valid
	assert repaired.symmetric_difference(expected).area < 1e-9 * expected.area


def _chaikin_coords(ring):
	return combined_inference._chaikin_ring(ring.coords, combined_inference.CHAIKIN_ITERATIONS)


def _write_mask(path, mask, pixel_size=0.05):
	import rasterio
	from rasterio.transform import from_origin

	with rasterio.open(
		path, 'w', driver='GTiff', height=mask.shape[0], width=mask.shape[1], count=1, dtype='uint8',
		crs='EPSG:32634', transform=from_origin(500000, 5000000, pixel_size, pixel_size),
	) as dst:
		dst.write(mask, 1)


def _dense_forest_mask():
	"""A 600 x 600 px forest at 5 cm with clearings that cross the block lines."""
	import numpy as np

	rng = np.random.default_rng(1379)
	mask = np.ones((600, 600), dtype=np.uint8)
	mask[:40, :] = 0  # open land along one edge
	for row, col, radius in zip(rng.integers(0, 600, 120), rng.integers(0, 600, 120), rng.integers(3, 25, 120)):
		rows, cols = np.ogrid[:600, :600]
		mask[(rows - row) ** 2 + (cols - col) ** 2 <= radius**2] = 0
	return mask


def test_treecover_in_blocks_keeps_the_area_and_no_polygon_spans_blocks(monkeypatch, tmp_path):
	"""Block-wise treecover covers the same ground as the whole-mask result, without
	gaps or overlaps along the block lines, and every polygon stays in its block (DT-1379)."""
	import shapely

	path = tmp_path / 'treecover.tif'
	_write_mask(path, _dense_forest_mask())
	monkeypatch.setattr(combined_inference, 'reproject_polygons', lambda polygons, src, dst: polygons)
	monkeypatch.setattr(combined_inference, 'TREECOVER_BLOCK_SIZE', 128)
	monkeypatch.setattr(combined_inference, 'TREECOVER_BLOCK_PADDING', 32)
	inference = CombinedInference.__new__(CombinedInference)
	crs = CRS.from_epsg(32634)
	messages = []

	whole = shapely.union_all(inference._polygons_from_mask(str(path), 1, 'treecover', crs, crs, lambda _: None))
	blocks = inference._treecover_polygons_in_blocks(str(path), crs, crs, messages.append)

	def block_of(x, y):
		return int((x - 500000) // (128 * 0.05)), int((5000000 - y) // (128 * 0.05))

	assert all(p.is_valid for p in blocks)
	assert all(block_of(p.bounds[0] + 1e-6, p.bounds[3] - 1e-6) == block_of(p.bounds[2] - 1e-6, p.bounds[1] + 1e-6) for p in blocks)
	union = shapely.union_all(blocks)
	assert abs(sum(p.area for p in blocks) - union.area) < 1e-6 * union.area  # no overlaps
	# VW and Chaikin vary a little with where a ring starts and ends, so the two results
	# differ by well under 1 %, spread over the tile rather than along the block lines.
	assert union.symmetric_difference(whole).area < 1e-2 * whole.area
	assert messages[0].startswith('Polygonized and simplified treecover in 128 px blocks')


def test_block_polygonization_tiles_the_mask_exactly(tmp_path):
	"""Clipped to their cores, the block polygons rebuild the mask pixel for pixel."""
	import numpy as np
	import rasterio
	import shapely

	from processor.src.utils.segmentation import mask_to_polygons_in_blocks

	path = tmp_path / 'mask.tif'
	mask = _dense_forest_mask()[:250, :190]
	_write_mask(path, mask, pixel_size=1)

	with rasterio.open(path) as ds:
		blocks = list(mask_to_polygons_in_blocks(ds, 1, 64, 8))
	pieces = [shapely.clip_by_rect(p, *core) for core, polygons in blocks for p in polygons]

	assert {core for core, _ in blocks} <= {
		(500000 + c, 5000000 - min(r + 64, 250), 500000 + min(c + 64, 190), 5000000 - r)
		for r in range(0, 250, 64)
		for c in range(0, 190, 64)
	}
	assert shapely.union_all(pieces).area == pytest.approx(float(mask.sum()))
	assert sum(p.area for p in pieces) == pytest.approx(float(mask.sum()))


# A smoothed forest patch from 13352 whose corner touches a block edge in one vertex.
# GEOS's clip_by_rect raises "Invalid number of points in LinearRing found 3" on it,
# which failed 13412's combined run (DT-1379).
EDGE_TOUCHING_PATCH = (
	'POLYGON ((317664.5318724416 8733705.79540955, 317664.3568724416 8733705.595409552, '
	'317664.18187244155 8733705.395409552, 317664.0068724416 8733705.195409551, '
	'317663.7568724416 8733705.057909552, 317663.43187244155 8733704.98290955, '
	'317663.31937244156 8733704.807909552, 317663.4193724416 8733704.53290955, '
	'317663.5568724416 8733704.382909551, 317663.7318724416 8733704.357909553, '
	'317663.9006224416 8733704.451659553, 317664.0631224416 8733704.664159551, '
	'317664.22562244156 8733704.87665955, 317664.3881224416 8733705.089159552, '
	'317664.5568724416 8733705.195409551, 317664.7318724416 8733705.195409551, '
	'317664.8818724416 8733705.307909552, 317665.0068724416 8733705.53290955, '
	'317664.95687244163 8733705.70790955, 317664.7318724416 8733705.83290955, '
	'317664.5318724416 8733705.79540955))'
)
EDGE_TOUCHING_BLOCK = (317513.3193724416, 8733662.14540955, 317663.3193724416, 8733812.14540955)


def test_a_patch_touching_the_block_edge_in_one_vertex_is_clipped_without_error(monkeypatch, tmp_path):
	import numpy as np
	import shapely

	monkeypatch.setattr(combined_inference, 'reproject_polygons', lambda polygons, src, dst: polygons)
	monkeypatch.setattr(
		combined_inference,
		'mask_to_polygons_in_blocks',
		lambda ds, value, size, padding: [(EDGE_TOUCHING_BLOCK, [shapely.from_wkt(EDGE_TOUCHING_PATCH)])],
	)
	monkeypatch.setattr(CombinedInference, '_simplify_polygons', lambda self, polygons: polygons)
	path = tmp_path / 'mask.tif'
	_write_mask(path, np.ones((2, 2), dtype=np.uint8))

	inference = CombinedInference.__new__(CombinedInference)
	crs = CRS.from_epsg(32738)

	assert inference._treecover_polygons_in_blocks(str(path), crs, crs, lambda _: None) == []
