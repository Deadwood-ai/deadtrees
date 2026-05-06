import pytest
from shapely.geometry import MultiPolygon, Point, Polygon

from processor.src.utils.geometry_validation import count_polygon_points, simplify_polygons_preserving_topology


def test_simplify_polygons_preserving_topology_reduces_vertices():
	polygon = Point(0, 0).buffer(10, resolution=128)
	points_before = count_polygon_points([polygon])

	simplified = simplify_polygons_preserving_topology([polygon], tolerance=0.05)

	assert len(simplified) == 1
	assert simplified[0].is_valid
	assert count_polygon_points(simplified) < points_before
	assert simplified[0].area == pytest.approx(polygon.area, rel=0.05)


def test_simplify_polygons_preserving_topology_keeps_holes():
	polygon = Polygon(
		Point(0, 0).buffer(10, resolution=128).exterior.coords,
		[Point(0, 0).buffer(2, resolution=64).exterior.coords],
	)

	simplified = simplify_polygons_preserving_topology([polygon], tolerance=0.05)

	assert len(simplified) == 1
	assert simplified[0].is_valid
	assert len(simplified[0].interiors) == 1


def test_simplify_polygons_preserving_topology_flattens_multipolygons():
	multipolygon = MultiPolygon([Point(0, 0).buffer(10, resolution=32), Point(30, 0).buffer(5, resolution=32)])

	simplified = simplify_polygons_preserving_topology([multipolygon], tolerance=0.05)

	assert len(simplified) == 2
	assert all(isinstance(polygon, Polygon) for polygon in simplified)
	assert count_polygon_points(simplified) < count_polygon_points([multipolygon])
