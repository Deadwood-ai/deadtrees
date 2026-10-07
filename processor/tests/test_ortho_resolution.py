"""Keeping the ODM orthophoto raster within a pixel budget (DT-915)."""

import pytest

from processor.src.utils.ortho_resolution import budgeted_resolution_cm, sparse_point_extent_m

pytestmark = pytest.mark.unit


def _points(*coordinates: tuple[float, float]) -> dict:
	return {'points': {str(i): {'coordinates': [x, y, 0.0]} for i, (x, y) in enumerate(coordinates)}}


def test_extent_pools_partial_reconstructions():
	assert sparse_point_extent_m([_points((0, 0), (100, 10)), _points((-50, 40))]) == (150, 40)


def test_extent_ignores_a_few_stray_points():
	grid = [(x, y) for x in range(100) for y in range(10)]
	assert sparse_point_extent_m([_points(*grid, (50_000, 0), (0, -50_000))]) == (99, 9)


def test_extent_needs_points():
	assert sparse_point_extent_m([{'points': {}}]) is None


def test_missions_within_budget_keep_the_requested_resolution():
	# 1 km² at 1 cm is 10 Gpx; a coarser GSD is left to ODM's own cap.
	assert budgeted_resolution_cm(1.0, (1000, 1000), 20e9) == 1.0


def test_large_missions_get_the_finest_resolution_that_fits():
	# Dataset 9654: ODM reported model bounds of 1682 x 3212 m.
	resolution = budgeted_resolution_cm(1.0, (1682.3, 3211.8), 7e9)
	assert resolution == 2.8
	assert 1682.3 * 3211.8 / (resolution / 100) ** 2 <= 7e9
