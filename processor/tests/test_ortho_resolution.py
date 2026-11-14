"""Keeping the ODM orthophoto raster within a pixel budget (DT-915)."""

import pytest

from processor.src.utils.ortho_resolution import (
	MissionExtent,
	budgeted_resolution_cm,
	mission_extent,
	reduced_resolution_note,
	source_gigapixels,
	too_large_to_texture,
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


def test_extent_is_camera_spread_plus_the_far_image_corner():
	recon = _reconstruction([_shot(0, 0, 100), _shot(1000, 2000, 100)], [(0, 0, 0), (500, 500, 0)])

	extent = mission_extent([recon])

	# Half diagonal = hypot(5000, 3750) / 5000 / 2 / focal = 0.8333, times 100 m height.
	assert extent.width_m == pytest.approx(1000 + 2 * 83.333, abs=0.01)
	assert extent.height_m == pytest.approx(2000 + 2 * 83.333, abs=0.01)
	# GSD = height / (focal * image size) = 100 / 3750 m.
	assert extent.gsd_cm == pytest.approx(2.667, abs=0.001)


def test_tilted_edge_shot_widens_the_extent():
	tilted = _shot(1000, 0, 100)
	tilted['rotation'] = [3.141592653589793 - 0.6981317, 0.0, 0.0]  # 40 degrees off nadir
	nadir = _reconstruction([_shot(0, 0, 100), _shot(1000, 0, 100)], [(0, 0, 0)])
	with_tilt = _reconstruction([_shot(0, 0, 100), tilted], [(0, 0, 0)])

	assert mission_extent([with_tilt]).height_m > 3 * mission_extent([nadir]).height_m


def test_far_outlier_points_do_not_inflate_the_extent():
	# 9654: a few sparse points hundreds of km away made the old estimate 352 x 862 km.
	points = [(0, 0, 0), (500, 500, 0), (300_000, 800_000, 0)]
	recon = _reconstruction([_shot(0, 0, 100), _shot(1000, 2000, 100)], points)

	assert mission_extent([recon]).width_m < 1200


def test_extent_needs_cameras_and_points():
	assert mission_extent([{'cameras': {}, 'shots': {}, 'points': {}}]) is None


def test_missions_within_budget_keep_the_requested_resolution():
	assert budgeted_resolution_cm(1.0, MissionExtent(900, 900, 1.5), 8.5e9) == 1.0


def test_near_budget_missions_are_capped_even_when_their_gsd_looks_coarse_enough():
	# ODM renders 10% finer than its GSD estimate: at 4.5 cm this 20 km² mission would be 9.9 Gpx.
	extent = MissionExtent(4000, 5000, 5.0)

	resolution = budgeted_resolution_cm(1.0, extent, 8.5e9)

	assert resolution == 4.9
	assert 4000 * 5000 / (resolution / 100) ** 2 <= 8.5e9
	# Not coarser than the native GSD, so the dataset gets no reduced-resolution note.
	assert reduced_resolution_note(resolution, extent) is None


def test_large_missions_get_the_finest_resolution_that_fits():
	extent = MissionExtent(1682.3, 3211.8, 1.5)  # 9654 model bounds

	resolution = budgeted_resolution_cm(1.0, extent, 8.5e9)

	assert resolution == 2.6
	assert 1682.3 * 3211.8 / (resolution / 100) ** 2 <= 8.5e9


def test_note_states_native_and_processed_resolution():
	note = reduced_resolution_note(2.6, MissionExtent(1682.3, 3211.8, 1.5))
	assert note == 'Orthophoto generated at 2.6 cm instead of the native ~1.5 cm because of its size (1.7 x 3.2 km).'


def test_source_gigapixels_counts_every_reconstructed_image():
	shots = [_shot(0, 0, 60), _shot(10, 0, 60)]
	partials = [_reconstruction(shots, [(0, 0, 0)], size=4000), _reconstruction(shots[:1], [(0, 0, 0)], size=2000)]

	assert source_gigapixels(partials) == pytest.approx((2 * 4000 * 3000 + 2000 * 1500) / 1e9)


@pytest.mark.parametrize(
	'width_m, height_m, gsd_cm, resolution_cm, source_gpx, expected',
	[
		(3029, 2607, 2.5, 3.1, 25.8, True),  # 8463 ran out of memory
		(1803, 3473, 2.5, 2.8, 43.6, True),  # 8935
		(1741, 3410, 2.9, 2.7, 44.3, True),  # 8936
		(2095, 2085, 2.4, 2.3, 39.3, True),  # 9212
		(2168, 2129, 2.6, 2.4, 36.9, True),  # 9251
		(6000, 6000, 3.3, 6.5, 25.3, False),  # 8937 succeeded: large, but with fewer source pixels
		(1630, 1252, 3.0, 1.6, 65.1, False),  # 11544 succeeded: many source pixels on a small area
		(9000, 9000, 2.0, 6.0, 44.0, False),  # textures are halved at 3 times the GSD
		(9000, 9000, 2.0, 5.9, 44.0, True),  # just below that they stay at full size
	],
)
def test_too_large_to_texture(width_m, height_m, gsd_cm, resolution_cm, source_gpx, expected):
	extent = MissionExtent(width_m=width_m, height_m=height_m, gsd_cm=gsd_cm)

	assert too_large_to_texture(extent, source_gpx, resolution_cm, 4.3, 25.5) is expected
