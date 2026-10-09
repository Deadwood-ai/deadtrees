"""Keeping the ODM orthophoto raster within a pixel budget (DT-915)."""

import pytest

from processor.src.utils.ortho_resolution import (
	MissionExtent,
	budgeted_resolution_cm,
	mission_extent,
	reduced_resolution_note,
)

pytestmark = pytest.mark.unit

# A nadir camera (identity rotation looks along +z; flip it to look down) at (x, y, height).
DOWN = [3.141592653589793, 0.0, 0.0]


def _shot(x: float, y: float, height: float) -> dict:
	# Rotation pi about x maps world (x, y, z) to camera (x, -y, -z); translation t = -R c.
	return {'camera': 'cam', 'rotation': DOWN, 'translation': [-x, y, height]}


def _reconstruction(shots: list[dict], points: list[tuple[float, float, float]], focal=0.75, size=5000) -> dict:
	return {
		'cameras': {'cam': {'projection_type': 'brown', 'width': size, 'height': size * 3 // 4, 'focal_x': focal}},
		'shots': {str(i): shot for i, shot in enumerate(shots)},
		'points': {str(i): {'coordinates': list(p)} for i, p in enumerate(points)},
	}


def test_extent_is_camera_spread_plus_one_footprint():
	recon = _reconstruction([_shot(0, 0, 100), _shot(1000, 2000, 100)], [(0, 0, 0), (500, 500, 0)])

	extent = mission_extent([recon])

	# Half footprint = height * 0.5 / focal = 100 * 0.5 / 0.75.
	assert extent.width_m == pytest.approx(1000 + 2 * 66.667, abs=0.01)
	assert extent.height_m == pytest.approx(2000 + 2 * 66.667, abs=0.01)
	# GSD = height / (focal * image size) = 100 / 3750 m.
	assert extent.gsd_cm == pytest.approx(2.667, abs=0.001)


def test_far_outlier_points_do_not_inflate_the_extent():
	# 9654: a few sparse points hundreds of km away made the old estimate 352 x 862 km.
	points = [(0, 0, 0), (500, 500, 0), (300_000, 800_000, 0)]
	recon = _reconstruction([_shot(0, 0, 100), _shot(1000, 2000, 100)], points)

	assert mission_extent([recon]).width_m < 1200


def test_extent_needs_cameras_and_points():
	assert mission_extent([{'cameras': {}, 'shots': {}, 'points': {}}]) is None


def test_missions_within_budget_keep_the_requested_resolution():
	assert budgeted_resolution_cm(1.0, MissionExtent(1000, 1000, 1.5), 8.5e9) == 1.0


def test_coarse_gsd_that_already_fits_is_left_to_odm():
	# 20 km² at 5 cm GSD is 8 Gpx: ODM renders at GSD, nothing to change.
	assert budgeted_resolution_cm(1.0, MissionExtent(4000, 5000, 5.0), 8.5e9) == 1.0


def test_large_missions_get_the_finest_resolution_that_fits():
	extent = MissionExtent(1682.3, 3211.8, 1.5)  # 9654 model bounds

	resolution = budgeted_resolution_cm(1.0, extent, 8.5e9)

	assert resolution == 2.6
	assert 1682.3 * 3211.8 / (resolution / 100) ** 2 <= 8.5e9


def test_note_states_native_and_processed_resolution():
	note = reduced_resolution_note(2.6, MissionExtent(1682.3, 3211.8, 1.5))
	assert note == 'Orthophoto generated at 2.6 cm instead of the native ~1.5 cm because of its size (1.7 x 3.2 km).'
