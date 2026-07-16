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


def _num_points(polygon):
	return len(polygon.exterior.coords) + sum(len(r.coords) for r in polygon.interiors)


def test_filter_polygons_simplifies(monkeypatch):
	"""_filter_polygons applies VW simplification + Chaikin smoothing: vertex counts
	drop while the feature is preserved and reprojected."""
	# Dense circle (~1024 vertices, ~6cm spacing) so VW 0.0625m² reduces it.
	polygon = Point(0, 0).buffer(10, resolution=256)
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
	polygon = Point(0, 0).buffer(10, resolution=128)

	monkeypatch.setattr(combined_inference, 'reproject_polygons', lambda polys, s, d: polys)
	monkeypatch.setattr(combined_inference, 'VW_AREA_THRESHOLD', 1e6)

	inference = CombinedInference.__new__(CombinedInference)
	result = inference._filter_polygons([polygon], CRS.from_epsg(32634), CRS.from_epsg(4326))

	assert len(result) == 1
	assert not result[0].is_empty


def test_simplify_and_smooth_preserves_holes():
	"""A polygon with a sizeable hole keeps its hole through VW + Chaikin."""
	exterior = Point(0, 0).buffer(10, resolution=128)
	hole = Point(0, 0).buffer(3, resolution=128)
	polygon = Polygon(exterior.exterior.coords, [hole.exterior.coords])

	result = combined_inference._simplify_and_smooth(polygon)

	assert len(result) == 1
	assert len(result[0].interiors) == 1
	assert result[0].is_valid


def test_simplify_and_smooth_returns_polygons():
	"""Output geometries are always Polygons (never Multi*), matching the
	one-Polygon-in / list-of-Polygons-out contract downstream relies on."""
	polygon = Point(0, 0).buffer(10, resolution=256)

	result = combined_inference._simplify_and_smooth(polygon)

	assert result
	assert all(g.geom_type == 'Polygon' and not g.is_empty for g in result)
