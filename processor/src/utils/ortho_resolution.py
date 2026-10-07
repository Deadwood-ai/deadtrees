"""Keep the ODM orthophoto raster within a pixel budget (DT-915).

ODM's orthophoto step holds the whole output raster in memory (colour bands, alpha and a
float depth buffer, about 8 bytes per pixel) next to every texture. A large mission flown
at fine GSD therefore needs more memory than the ODM container has: dataset 9654 covers
5.4 km² and is killed in ``odm_orthophoto`` at 100 GB.

ODM never renders finer than the mission's GSD. This module only raises the requested
resolution when the reconstructed extent at that resolution would exceed the budget, so
missions that fit keep exactly their current output.
"""

from __future__ import annotations

import math

# Share of sparse points ignored at each end of an axis, so a few stray points do not
# stretch the extent the way ODM's outlier-filtered mesh would not.
EXTENT_TRIM_FRACTION = 0.005


def sparse_point_extent_m(reconstructions: list[dict]) -> tuple[float, float] | None:
	"""Width and height in metres of the sparse points of an OpenSfM ``reconstruction.json``.

	All partial reconstructions share one topocentric frame, so their points are pooled.
	"""
	xs: list[float] = []
	ys: list[float] = []
	for reconstruction in reconstructions:
		for point in reconstruction.get('points', {}).values():
			x, y, _ = point['coordinates']
			xs.append(x)
			ys.append(y)
	if len(xs) < 2:
		return None
	return _trimmed_span(xs), _trimmed_span(ys)


def _trimmed_span(values: list[float]) -> float:
	values = sorted(values)
	cut = int(len(values) * EXTENT_TRIM_FRACTION)
	return values[len(values) - 1 - cut] - values[cut]


def budgeted_resolution_cm(requested_cm: float, extent_m: tuple[float, float], max_pixels: float) -> float:
	"""The finest resolution at or above ``requested_cm`` whose raster over ``extent_m`` fits ``max_pixels``."""
	width_m, height_m = extent_m
	finest_cm = math.sqrt(width_m * height_m / max_pixels) * 100
	if finest_cm <= requested_cm:
		return requested_cm
	# Round up to the next millimetre so the logged value is readable and still within budget.
	return math.ceil(finest_cm * 10) / 10
