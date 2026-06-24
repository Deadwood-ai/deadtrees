import pytest
from rasterio.crs import CRS
from shapely.geometry import Point

pytest.importorskip('safetensors')
pytest.importorskip('torch')
pytest.importorskip('torchvision')
pytest.importorskip('transformers')

from processor.src.deadwood_treecover_combined_v2.inference import combined_inference
from processor.src.deadwood_treecover_combined_v2.inference.combined_inference import CombinedInference


def _num_points(polygon):
	return len(polygon.exterior.coords) + sum(len(r.coords) for r in polygon.interiors)


def test_filter_polygons_does_not_simplify(monkeypatch):
	"""Forest cover is no longer simplified: vertex counts must be preserved,
	only area filtering and reprojection happen."""
	polygon = Point(0, 0).buffer(10, resolution=128)
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
	# No vertex reduction: simplification has been removed.
	assert _num_points(result[0]) == _num_points(polygon)
	assert reproject_call['src_crs'] == inference_crs
	assert reproject_call['dst_crs'] == orig_crs


def test_simplification_feature_fully_removed():
	"""The removed simplification feature must not leave behind helpers/attributes."""
	assert not hasattr(combined_inference, 'FOREST_COVER_SIMPLIFICATION_TOLERANCE_M')
	assert not hasattr(combined_inference, 'simplify_polygons_preserving_topology')
