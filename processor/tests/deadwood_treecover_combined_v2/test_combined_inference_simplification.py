import pytest
from rasterio.crs import CRS
from shapely.geometry import Point

pytest.importorskip('safetensors')
pytest.importorskip('torch')
pytest.importorskip('torchvision')
pytest.importorskip('transformers')

from processor.src.deadwood_treecover_combined_v2.inference import combined_inference
from processor.src.deadwood_treecover_combined_v2.inference.combined_inference import CombinedInference
from processor.src.utils.geometry_validation import count_polygon_points


def test_forest_cover_simplification_runs_before_reproject(monkeypatch):
	polygon = Point(0, 0).buffer(10, resolution=128)
	inference_crs = CRS.from_epsg(32634)
	orig_crs = CRS.from_epsg(4326)
	reproject_call = {}
	events = []
	original_simplify = combined_inference.simplify_polygons_preserving_topology

	monkeypatch.setattr(combined_inference, 'mask_to_polygons', lambda mask, image_src: [polygon])

	def fake_simplify(polygons, tolerance):
		events.append('simplify')
		return original_simplify(polygons, tolerance)

	def fake_filter(polygons, min_area):
		events.append('filter')
		return polygons

	monkeypatch.setattr(combined_inference, 'simplify_polygons_preserving_topology', fake_simplify)
	monkeypatch.setattr(combined_inference, 'filter_polygons_by_area', fake_filter)

	def fake_reproject_polygons(polygons, src_crs, dst_crs):
		reproject_call['src_crs'] = src_crs
		reproject_call['dst_crs'] = dst_crs
		reproject_call['points'] = count_polygon_points(polygons)
		return polygons

	monkeypatch.setattr(combined_inference, 'reproject_polygons', fake_reproject_polygons)

	inference = CombinedInference.__new__(CombinedInference)
	inference.simplification_stats = {}

	result = inference._mask_to_filtered_polygons(
		mask=None,
		image_src=object(),
		inference_crs=inference_crs,
		orig_crs=orig_crs,
		simplification_tolerance=0.05,
		stats_key='forest_cover',
	)

	assert result
	assert events == ['simplify', 'filter']
	assert reproject_call['src_crs'] == inference_crs
	assert reproject_call['dst_crs'] == orig_crs
	assert reproject_call['points'] < count_polygon_points([polygon])
	assert inference.simplification_stats['forest_cover'] == {
		'tolerance_m': 0.05,
		'simplification_crs': 'EPSG:32634',
		'polygons': 1,
		'points_before': count_polygon_points([polygon]),
		'points_after': reproject_call['points'],
	}
