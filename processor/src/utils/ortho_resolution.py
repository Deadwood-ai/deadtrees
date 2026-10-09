"""Keep the ODM orthophoto raster within a pixel budget (DT-915).

ODM's orthophoto step holds the whole output raster in memory (colour bands, alpha and a
float depth buffer, about 8 bytes per pixel) next to every texture. A large mission flown
at fine GSD therefore needs more memory than the ODM container has: dataset 9654 covers
5.4 km² and is killed in ``odm_orthophoto`` at 100 GB.

ODM never renders finer than the mission's GSD. This module only raises the requested
resolution when the mission's extent at its GSD would exceed the budget, so missions that
fit keep exactly their current output.

The extent comes from the reconstructed camera positions plus half an image footprint,
not from the sparse points: a few mis-triangulated points can lie hundreds of km away
(9654: 352 × 862 km against ODM's 1.7 × 3.2 km model), while cameras stay where the
drone flew.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass

from processor.src.utils.reconstruction_orientation import camera_center


@dataclass(frozen=True)
class MissionExtent:
	width_m: float
	height_m: float
	gsd_cm: float


def mission_extent(reconstructions: list[dict]) -> MissionExtent | None:
	"""Ground extent and GSD of an OpenSfM ``reconstruction.json`` (all partials share one frame)."""
	centers = []
	heights = []
	half_fov_tan = 0.0
	gsd_cm = []
	for reconstruction in reconstructions:
		shots = reconstruction.get('shots', {})
		point_z = [point['coordinates'][2] for point in reconstruction.get('points', {}).values()]
		if not shots or not point_z:
			continue
		ground_z = statistics.median(point_z)
		cameras = reconstruction.get('cameras', {})
		for shot in shots.values():
			camera = cameras.get(shot.get('camera'), {})
			focal = camera.get('focal_x', camera.get('focal'))
			size = max(camera.get('width', 0), camera.get('height', 0))
			if not focal or not size:
				continue
			center = camera_center(shot)
			height = center[2] - ground_z
			if height <= 0:
				continue
			centers.append(center)
			heights.append(height)
			# OpenSfM focal lengths are normalised by the larger image side.
			half_fov_tan = max(half_fov_tan, 0.5 / focal)
			gsd_cm.append(height / (focal * size) * 100)
	if len(centers) < 2:
		return None
	margin = statistics.median(heights) * half_fov_tan
	xs = [center[0] for center in centers]
	ys = [center[1] for center in centers]
	return MissionExtent(
		width_m=max(xs) - min(xs) + 2 * margin,
		height_m=max(ys) - min(ys) + 2 * margin,
		gsd_cm=statistics.median(gsd_cm),
	)


def budgeted_resolution_cm(requested_cm: float, extent: MissionExtent, max_pixels: float) -> float:
	"""The resolution to request: ``requested_cm`` unless the raster at the mission's GSD would exceed ``max_pixels``."""
	finest_cm = math.sqrt(extent.width_m * extent.height_m / max_pixels) * 100
	if finest_cm <= max(requested_cm, extent.gsd_cm):
		return requested_cm
	# Round up to the next millimetre so the logged value is readable and still within budget.
	return math.ceil(finest_cm * 10) / 10


def reduced_resolution_note(resolution_cm: float, extent: MissionExtent) -> str:
	"""Text for the dataset's additional information when the cap lowered the resolution."""
	return (
		f'Orthophoto generated at {resolution_cm:g} cm instead of the native ~{extent.gsd_cm:.1f} cm '
		f'because of its size ({extent.width_m / 1000:.1f} x {extent.height_m / 1000:.1f} km).'
	)
