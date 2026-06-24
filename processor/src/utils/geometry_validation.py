"""
Geometry validation and fixing utilities for segmentation outputs.

This module provides functions to validate and fix geometries before saving to database.
Geometries can become invalid due to:
- OpenCV contour artifacts (self-intersections, duplicate points)
- CRS reprojection issues
- Numerical precision errors

These utilities should be called AFTER all reprojections but BEFORE saving to database.
"""

from shapely.geometry import Polygon, MultiPolygon
from shapely.validation import explain_validity
from shared.logger import logger
from shared.logging import LogContext, LogCategory


def validate_and_fix_polygon(polygon: Polygon, min_area: float = 0.0) -> Polygon | None:
	"""
	Validate and fix a single polygon geometry.

	Args:
		polygon: Shapely Polygon to validate
		min_area: Minimum area threshold (in CRS units). Polygons smaller than this are discarded.

	Returns:
		Fixed valid polygon, or None if polygon cannot be fixed or is too small
	"""
	if polygon is None or polygon.is_empty:
		return None

	# Check if already valid
	if polygon.is_valid:
		# Even if valid, check area
		if min_area > 0 and polygon.area < min_area:
			return None
		return polygon

	# Try to fix invalid geometry
	try:
		# Method 1: buffer(0) - Classic fix for most topology issues
		fixed = polygon.buffer(0)

		# If buffer(0) returns empty or wrong type, discard
		if fixed.is_empty or not isinstance(fixed, (Polygon, MultiPolygon)):
			return None

		# If buffer(0) created MultiPolygon, take largest part
		if isinstance(fixed, MultiPolygon):
			# Sort by area and take the largest polygon
			parts = sorted(fixed.geoms, key=lambda p: p.area, reverse=True)
			if parts:
				fixed = parts[0]
			else:
				return None

		# Check area after fixing
		if min_area > 0 and fixed.area < min_area:
			return None

		return fixed

	except Exception as e:
		logger.warning(
			f'Could not fix invalid polygon: {e}',
			LogContext(category=LogCategory.ORTHO, extra={'error': str(e), 'validity': explain_validity(polygon)}),
		)
		return None


def validate_and_fix_polygons(
	polygons: list[Polygon], min_area: float = 0.0, dataset_id: int = None, label_type: str = 'geometry'
) -> tuple[list[Polygon], dict]:
	"""
	Validate and fix a list of polygons, removing invalid ones.

	Args:
		polygons: List of Shapely Polygons to validate
		min_area: Minimum area threshold (in CRS units)
		dataset_id: Dataset ID for logging
		label_type: Type of label for logging (e.g., 'deadwood', 'treecover')

	Returns:
		Tuple of (valid_polygons, stats_dict)
	"""
	if len(polygons) == 0:
		return [], {'total': 0, 'valid': 0, 'fixed': 0, 'invalid': 0, 'too_small': 0}

	valid_polygons = []
	stats = {
		'total': len(polygons),
		'valid': 0,
		'fixed': 0,
		'invalid': 0,
		'too_small': 0,
	}

	for i, poly in enumerate(polygons):
		if poly is None or poly.is_empty:
			stats['invalid'] += 1
			continue

		was_valid = poly.is_valid

		# Validate and fix
		fixed_poly = validate_and_fix_polygon(poly, min_area=min_area)

		if fixed_poly is None:
			if was_valid and min_area > 0:
				stats['too_small'] += 1
			else:
				stats['invalid'] += 1
			continue

		if was_valid:
			stats['valid'] += 1
		else:
			stats['fixed'] += 1
			logger.debug(
				f'Fixed invalid {label_type} polygon {i}: {explain_validity(poly)}',
				LogContext(
					category=LogCategory.ORTHO,
					dataset_id=dataset_id,
					extra={'polygon_index': i, 'validity_issue': explain_validity(poly)},
				),
			)

		valid_polygons.append(fixed_poly)

	# Log summary
	if stats['fixed'] > 0 or stats['invalid'] > 0:
		logger.info(
			f'Geometry validation for {label_type}: {stats["total"]} total, '
			f'{stats["valid"]} valid, {stats["fixed"]} fixed, '
			f'{stats["invalid"]} invalid, {stats["too_small"]} too small',
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=dataset_id,
				extra={'validation_stats': stats, 'label_type': label_type},
			),
		)

	return valid_polygons, stats


def filter_degenerate_geometries(polygons: list[Polygon], min_points: int = 3) -> list[Polygon]:
	"""
	Filter out degenerate geometries (< 3 points, zero area, etc.)

	Args:
		polygons: List of Shapely Polygons
		min_points: Minimum number of points for valid polygon

	Returns:
		Filtered list of polygons
	"""
	filtered = []
	for poly in polygons:
		if poly is None or poly.is_empty:
			continue

		# Check exterior ring has enough points
		if len(poly.exterior.coords) < min_points:
			continue

		# Check area is non-zero
		if poly.area == 0:
			continue

		filtered.append(poly)

	return filtered
