"""
Unit tests for geometry validation module.

Tests validation and fixing of invalid geometries that commonly occur from:
- OpenCV contour extraction (self-intersections, duplicate points)
- CRS reprojection artifacts
- Numerical precision errors

These patterns are based on real-world invalid geometries from segmentation outputs.
"""

import pytest
from shapely.geometry import Polygon, MultiPolygon, Point
from shapely.validation import explain_validity
from processor.src.utils.geometry_validation import (
	validate_and_fix_polygon,
	validate_and_fix_polygons,
	filter_degenerate_geometries,
)


class TestValidateAndFixPolygon:
	"""Test single polygon validation and fixing"""

	def test_valid_polygon_unchanged(self):
		"""Valid polygon should pass through unchanged"""
		poly = Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])
		result = validate_and_fix_polygon(poly)

		assert result is not None
		assert result.is_valid
		assert result.equals(poly)

	def test_invalid_bowtie_polygon(self):
		"""Self-intersecting bowtie polygon should be fixed"""
		# Classic bowtie: two triangles touching at a point
		bowtie = Polygon([(0, 0), (2, 2), (2, 0), (0, 2), (0, 0)])

		result = validate_and_fix_polygon(bowtie)

		# Should either fix it or return None
		if result is not None:
			assert result.is_valid
			# buffer(0) typically splits bowtie into two polygons
			# We take the largest, so result should be valid

	def test_invalid_self_intersecting_polygon(self):
		"""Self-intersecting polygon (figure-8) should be fixed"""
		# Figure-8 pattern
		figure8 = Polygon([(0, 0), (1, 1), (2, 0), (2, 2), (1, 1), (0, 2), (0, 0)])

		result = validate_and_fix_polygon(figure8)

		# Should fix or return None
		if result is not None:
			assert result.is_valid

	def test_duplicate_vertices_polygon(self):
		"""Polygon with duplicate consecutive vertices"""
		# This pattern occurs from OpenCV contour extraction
		poly_with_dupes = Polygon([(0, 0), (0, 0), (1, 0), (1, 0), (1, 1), (1, 1), (0, 1), (0, 0)])

		result = validate_and_fix_polygon(poly_with_dupes)

		assert result is not None
		assert result.is_valid

	def test_zero_area_polygon_filtered(self):
		"""Zero-area polygon (degenerate line) should be filtered"""
		# Polygon collapsed to a line
		degenerate = Polygon([(0, 0), (1, 0), (1, 0), (0, 0)])

		result = validate_and_fix_polygon(degenerate, min_area=0.01)

		# Should return None (zero area)
		assert result is None

	def test_small_polygon_filtered_by_area(self):
		"""Small polygon should be filtered when min_area is set"""
		small_poly = Polygon([(0, 0), (0.01, 0), (0.01, 0.01), (0, 0.01)])

		result = validate_and_fix_polygon(small_poly, min_area=1.0)

		assert result is None  # Area is 0.0001, less than min_area

	def test_empty_polygon(self):
		"""Empty polygon should return None"""
		empty = Polygon()

		result = validate_and_fix_polygon(empty)

		assert result is None

	def test_none_polygon(self):
		"""None input should return None"""
		result = validate_and_fix_polygon(None)

		assert result is None

	def test_polygon_with_invalid_hole(self):
		"""Polygon with self-intersecting hole"""
		exterior = [(0, 0), (10, 0), (10, 10), (0, 10)]
		# Invalid hole with self-intersection
		hole = [(2, 2), (6, 6), (6, 2), (2, 6)]

		poly = Polygon(exterior, [hole])

		result = validate_and_fix_polygon(poly)

		# Should fix the invalid hole
		if result is not None:
			assert result.is_valid


class TestValidateAndFixPolygons:
	"""Test batch polygon validation"""

	def test_batch_all_valid(self):
		"""All valid polygons should pass through"""
		polygons = [
			Polygon([(0, 0), (1, 0), (1, 1), (0, 1)]),
			Polygon([(5, 5), (6, 5), (6, 6), (5, 6)]),
			Polygon([(10, 10), (11, 10), (11, 11), (10, 11)]),
		]

		valid_polys, stats = validate_and_fix_polygons(polygons)

		assert len(valid_polys) == 3
		assert stats['total'] == 3
		assert stats['valid'] == 3
		assert stats['fixed'] == 0
		assert stats['invalid'] == 0

	def test_batch_mixed_validity(self):
		"""Mix of valid and invalid polygons"""
		polygons = [
			Polygon([(0, 0), (1, 0), (1, 1), (0, 1)]),  # Valid
			Polygon([(0, 0), (2, 2), (2, 0), (0, 2)]),  # Invalid bowtie
			Polygon([(5, 5), (6, 5), (6, 6), (5, 6)]),  # Valid
			Polygon(),  # Empty (invalid)
		]

		valid_polys, stats = validate_and_fix_polygons(polygons)

		assert stats['total'] == 4
		assert stats['valid'] == 2  # Two were valid
		assert stats['fixed'] + stats['invalid'] == 2  # Two needed fixing/removal
		assert all(p.is_valid for p in valid_polys)

	def test_batch_empty_list(self):
		"""Empty input list should return empty result"""
		valid_polys, stats = validate_and_fix_polygons([])

		assert len(valid_polys) == 0
		assert stats['total'] == 0

	def test_batch_with_area_filtering(self):
		"""Batch validation with minimum area filter"""
		polygons = [
			Polygon([(0, 0), (10, 0), (10, 10), (0, 10)]),  # Area = 100
			Polygon([(0, 0), (0.1, 0), (0.1, 0.1), (0, 0.1)]),  # Area = 0.01
			Polygon([(20, 20), (21, 20), (21, 21), (20, 21)]),  # Area = 1
		]

		valid_polys, stats = validate_and_fix_polygons(polygons, min_area=0.5)

		# Only polygons with area >= 0.5 should remain
		assert len(valid_polys) == 2
		assert stats['too_small'] == 1

	def test_batch_all_invalid(self):
		"""All invalid polygons should be fixed or removed"""
		polygons = [
			Polygon([(0, 0), (2, 2), (2, 0), (0, 2)]),  # Bowtie
			Polygon(),  # Empty
			Polygon([(0, 0), (1, 0), (1, 0)]),  # Degenerate
		]

		valid_polys, stats = validate_and_fix_polygons(polygons)

		# All should be fixed or removed
		assert all(p.is_valid for p in valid_polys)
		assert stats['valid'] == 0


class TestFilterDegenerateGeometries:
	"""Test degenerate geometry filtering"""

	def test_filter_zero_area(self):
		"""Zero-area polygons should be filtered"""
		polygons = [
			Polygon([(0, 0), (1, 0), (1, 1), (0, 1)]),  # Valid
			Polygon([(0, 0), (1, 0), (1, 0), (0, 0)]),  # Zero area (line)
		]

		filtered = filter_degenerate_geometries(polygons)

		assert len(filtered) == 1
		assert filtered[0].area > 0

	def test_filter_insufficient_points(self):
		"""Polygons with < 3 points should be filtered"""
		# Note: Shapely typically prevents < 3 points, but test the filter
		valid_poly = Polygon([(0, 0), (1, 0), (1, 1), (0, 1)])

		filtered = filter_degenerate_geometries([valid_poly])

		assert len(filtered) == 1

	def test_filter_none_and_empty(self):
		"""None and empty polygons should be filtered"""
		polygons = [
			Polygon([(0, 0), (1, 0), (1, 1), (0, 1)]),  # Valid
			None,
			Polygon(),  # Empty
		]

		filtered = filter_degenerate_geometries(polygons)

		assert len(filtered) == 1
		assert filtered[0].is_valid


class TestRealWorldPatterns:
	"""Test patterns observed in real segmentation outputs"""

	def test_opencv_contour_artifacts(self):
		"""
		OpenCV findContours can produce polygons with:
		- Duplicate consecutive points
		- Near-duplicate points with floating point errors
		"""
		# Simulate OpenCV contour with duplicates
		contour_poly = Polygon(
			[
				(100.0, 100.0),
				(100.0, 100.0),  # Duplicate
				(200.0, 100.0),
				(200.00000001, 100.0),  # Near-duplicate (FP error)
				(200.0, 200.0),
				(100.0, 200.0),
			]
		)

		result = validate_and_fix_polygon(contour_poly)

		assert result is not None
		assert result.is_valid
		assert result.area > 0

	def test_reprojection_artifacts(self):
		"""
		CRS reprojection can introduce small self-intersections
		at polygon boundaries
		"""
		# Simulate polygon that becomes invalid after reprojection
		# (self-intersection at boundary)
		reprojected_poly = Polygon(
			[
				(7.735, 50.418),
				(7.736, 50.418),
				(7.7355, 50.4185),  # Creates small self-intersection
				(7.736, 50.419),
				(7.735, 50.419),
			]
		)

		result = validate_and_fix_polygon(reprojected_poly)

		# Should either fix or return valid result
		if result is not None:
			assert result.is_valid

	def test_tiled_inference_boundary_artifacts(self):
		"""
		Tiled inference can create polygons with artifacts at tile boundaries
		"""
		# Polygon from tile boundary with numerical precision issues
		boundary_poly = Polygon(
			[
				(0.0, 0.0),
				(512.0, 0.0),
				(512.0, 512.0),
				(511.99999999, 512.0),  # Precision artifact
				(0.0, 512.0),
			]
		)

		result = validate_and_fix_polygon(boundary_poly)

		assert result is not None
		assert result.is_valid

	def test_complex_multipart_after_buffer(self):
		"""
		Some invalid polygons split into MultiPolygon after buffer(0)
		We should take the largest component
		"""
		# Bowtie that will split into two polygons
		bowtie = Polygon([(0, 0), (10, 10), (10, 0), (0, 10), (0, 0)])

		result = validate_and_fix_polygon(bowtie)

		# Result should be largest component (single Polygon)
		if result is not None:
			assert isinstance(result, Polygon)
			assert result.is_valid

	def test_real_world_batch_scenario(self):
		"""
		Simulate real batch from segmentation output:
		- Mix of valid and invalid geometries
		- Various invalid patterns
		- Different sizes
		"""
		polygons = [
			# Valid polygons (typical tree cover)
			Polygon([(0, 0), (5, 0), (5, 5), (0, 5)]),
			Polygon([(10, 10), (15, 10), (15, 15), (10, 15)]),
			# Invalid bowtie (from complex shape segmentation)
			Polygon([(20, 20), (25, 25), (25, 20), (20, 25)]),
			# Polygon with duplicate vertices (from OpenCV)
			Polygon([(30, 30), (30, 30), (35, 30), (35, 35), (30, 35)]),
			# Very small polygon (noise)
			Polygon([(40, 40), (40.01, 40), (40.01, 40.01), (40, 40.01)]),
			# Empty polygon
			Polygon(),
		]

		valid_polys, stats = validate_and_fix_polygons(
			polygons,
			min_area=0.5,  # Filter noise
			dataset_id=5830,
			label_type='treecover',
		)

		# Should have fixed/filtered problematic geometries
		assert all(p.is_valid for p in valid_polys)
		assert len(valid_polys) >= 2  # At least the two valid ones
		assert stats['total'] == 6
		assert stats['valid'] >= 2


class TestEdgeCases:
	"""Test edge cases and boundary conditions"""

	def test_very_large_polygon(self):
		"""Very large polygon should be handled correctly"""
		# Large polygon (1000x1000 units)
		large_poly = Polygon([(0, 0), (1000, 0), (1000, 1000), (0, 1000)])

		result = validate_and_fix_polygon(large_poly)

		assert result is not None
		assert result.is_valid
		assert result.area == 1000000

	def test_very_small_valid_polygon(self):
		"""Very small but valid polygon"""
		tiny_poly = Polygon([(0, 0), (0.000001, 0), (0.000001, 0.000001), (0, 0.000001)])

		result = validate_and_fix_polygon(tiny_poly, min_area=0.0)

		assert result is not None
		assert result.is_valid

	def test_polygon_with_many_vertices(self):
		"""Polygon with many vertices (complex shape)"""
		# Circle approximation with 100 vertices
		import math

		vertices = [(math.cos(2 * math.pi * i / 100), math.sin(2 * math.pi * i / 100)) for i in range(100)]
		complex_poly = Polygon(vertices)

		result = validate_and_fix_polygon(complex_poly)

		assert result is not None
		assert result.is_valid

	def test_polygon_with_multiple_holes(self):
		"""Valid polygon with multiple holes"""
		exterior = [(0, 0), (10, 0), (10, 10), (0, 10)]
		hole1 = [(2, 2), (4, 2), (4, 4), (2, 4)]
		hole2 = [(6, 6), (8, 6), (8, 8), (6, 8)]

		poly = Polygon(exterior, [hole1, hole2])

		result = validate_and_fix_polygon(poly)

		assert result is not None
		assert result.is_valid
		assert len(list(result.interiors)) == 2
