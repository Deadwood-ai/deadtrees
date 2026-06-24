"""Tests for filter_polygons_by_area, in particular interior-ring (hole) filtering.

Regression coverage for a bug where the function built a hole-filtered polygon to
test the area threshold but then appended the *original* polygon, so sub-threshold
holes were never actually removed from the stored geometry.
"""

from shapely.geometry import Polygon

from processor.src.utils.segmentation import filter_polygons_by_area


def _square(size, origin=(0.0, 0.0)):
	ox, oy = origin
	return [(ox, oy), (ox, oy + size), (ox + size, oy + size), (ox + size, oy), (ox, oy)]


def test_small_holes_are_removed():
	# 10x10 exterior (area 100) with one tiny hole (area 1) and one large hole (area 16).
	poly = Polygon(_square(10), [_square(1, (2, 2)), _square(4, (3, 3))])

	(result,) = filter_polygons_by_area([poly], min_area=5)

	# The tiny hole is dropped; the large hole is preserved.
	assert len(result.interiors) == 1
	assert result.interiors[0].length > 0
	# Net area = exterior - kept hole = 100 - 16.
	assert result.area == 84


def test_polygon_with_only_a_tiny_hole_keeps_no_holes():
	# The exact shape of the production bug: a large polygon whose only hole is a
	# sub-threshold triangle. The hole must be gone, the polygon must remain.
	tiny_triangle = [(5.0, 5.0), (5.1, 5.0), (5.0, 5.1), (5.0, 5.0)]
	poly = Polygon(_square(10), [tiny_triangle])

	(result,) = filter_polygons_by_area([poly], min_area=1)

	assert len(result.interiors) == 0
	assert result.area == 100


def test_all_large_holes_are_kept():
	poly = Polygon(_square(30), [_square(5, (5, 5)), _square(6, (15, 15))])

	(result,) = filter_polygons_by_area([poly], min_area=1)

	assert len(result.interiors) == 2


def test_polygon_below_min_area_is_dropped():
	small = Polygon(_square(2))  # area 4
	big = Polygon(_square(10))  # area 100

	result = filter_polygons_by_area([small, big], min_area=5)

	assert len(result) == 1
	assert result[0].area == 100


def test_polygon_kept_when_net_area_above_threshold():
	# Exterior area 100, large hole area 64 -> net 36, still above threshold.
	poly = Polygon(_square(10), [_square(8, (1, 1))])

	result = filter_polygons_by_area([poly], min_area=5)

	assert len(result) == 1
	assert result[0].area == 36
