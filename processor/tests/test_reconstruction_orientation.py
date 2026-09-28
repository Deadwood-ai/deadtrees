import math

import numpy as np
import pytest

from processor.src.utils.reconstruction_orientation import (
	filter_reconstructions_by_orientation,
	gps_defines_vertical,
	off_nadir_degrees,
	partials_from_opensfm_report,
)

pytestmark = pytest.mark.unit


def _rotation_matrix_to_angle_axis(matrix: np.ndarray) -> list[float]:
	angle = math.acos(max(-1.0, min(1.0, (np.trace(matrix) - 1) / 2)))
	if angle < 1e-9:
		return [0.0, 0.0, 0.0]
	if abs(angle - math.pi) < 1e-6:
		# axis from the symmetric part: R = 2 a a^T - I
		axis = np.sqrt(np.clip((np.diag(matrix) + 1) / 2, 0, None))
		largest = int(np.argmax(axis))
		for i in range(3):
			if i != largest:
				axis[i] = math.copysign(axis[i], matrix[largest, i])
		return list(axis * angle)
	axis = np.array([matrix[2, 1] - matrix[1, 2], matrix[0, 2] - matrix[2, 0], matrix[1, 0] - matrix[0, 1]])
	return list(axis / (2 * math.sin(angle)) * angle)


def _world_to_camera_rotation(off_nadir: float, yaw: float = 0.0, tilt_azimuth: float = 0.0) -> list[float]:
	"""OpenSfM angle-axis for a camera tilted ``off_nadir`` degrees from straight down."""

	def rot_x(deg):
		c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
		return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])

	def rot_z(deg):
		c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
		return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])

	# Rx(180 - tilt) looks down, tilted towards +y; the z rotations leave the vertical untouched.
	matrix = rot_z(yaw) @ rot_x(180.0 - off_nadir) @ rot_z(tilt_azimuth)
	return _rotation_matrix_to_angle_axis(matrix)


def _shot(off_nadir: float, position, yaw: float = 0.0, gps: bool = True) -> dict:
	shot = {
		'rotation': _world_to_camera_rotation(off_nadir, yaw=yaw, tilt_azimuth=yaw * 0.5),
		'translation': [0.0, 0.0, 0.0],
		'camera': 'cam',
	}
	if gps:
		shot.update({'gps_position': list(position), 'gps_dop': 5.0})
	return shot


def _grid_reconstruction(angles: dict[str, float], spacing_m: float = 20.0, gps: bool = True) -> dict:
	shots = {}
	for index, (shot_id, angle) in enumerate(angles.items()):
		position = ((index % 4) * spacing_m, (index // 4) * spacing_m, 100.0)
		shots[shot_id] = _shot(angle, position, yaw=37.0 * index, gps=gps)
	return {
		'cameras': {'cam': {'projection_type': 'brown'}},
		'shots': shots,
		'points': {'1': {'coordinates': [0, 0, 0], 'color': [0, 0, 0]}},
		'rig_instances': {shot_id: {'rig_camera_ids': {shot_id: 'cam'}} for shot_id in shots},
	}


@pytest.mark.parametrize('angle', [0.0, 3.0, 10.0, 25.0, 45.0, 90.0, 135.0])
@pytest.mark.parametrize('yaw', [0.0, 73.0, -160.0])
def test_off_nadir_degrees_recovers_known_tilts(angle, yaw):
	rotation = _world_to_camera_rotation(angle, yaw=yaw, tilt_azimuth=-2 * yaw)
	assert off_nadir_degrees(rotation) == pytest.approx(angle, abs=1e-6)


def test_off_nadir_degrees_identity_rotation_looks_straight_up():
	# OpenSfM cameras look along +z; the identity pose therefore points at the zenith.
	assert off_nadir_degrees([0.0, 0.0, 0.0]) == pytest.approx(180.0)


def test_gps_defines_vertical_for_area_flight():
	reconstruction = _grid_reconstruction({f's{i}': 0.0 for i in range(12)})
	measured, _ = gps_defines_vertical(list(reconstruction['shots'].values()))
	assert measured


def test_gps_defines_vertical_rejects_single_line():
	shots = {f's{i}': _shot(0.0, (i * 10.0, 0.0, 100.0)) for i in range(10)}
	measured, reason = gps_defines_vertical(list(shots.values()))
	assert not measured
	assert 'line' in reason


def test_gps_defines_vertical_rejects_narrow_corridor():
	shots = {f's{i}': _shot(0.0, (i * 10.0, (i % 2) * 2.0, 100.0)) for i in range(20)}
	measured, reason = gps_defines_vertical(list(shots.values()))
	assert not measured
	assert 'across the flight direction' in reason


def test_gps_defines_vertical_requires_gps():
	reconstruction = _grid_reconstruction({f's{i}': 0.0 for i in range(8)}, gps=False)
	measured, reason = gps_defines_vertical(list(reconstruction['shots'].values()))
	assert not measured
	assert 'GPS' in reason


def test_filter_drops_oblique_shots_and_keeps_rig_instances_consistent():
	angles = {'nadir_a': 1.0, 'nadir_b': 4.0, 'edge': 9.9, 'oblique_a': 25.0, 'oblique_b': 60.0, 'nadir_c': 0.5}
	reconstruction = _grid_reconstruction(angles)

	(filtered,), result = filter_reconstructions_by_orientation([reconstruction], max_off_nadir_degrees=10.0)

	assert sorted(result.kept) == ['edge', 'nadir_a', 'nadir_b', 'nadir_c']
	assert sorted(shot_id for shot_id, _ in result.excluded) == ['oblique_a', 'oblique_b']
	assert dict(result.excluded)['oblique_a'] == pytest.approx(25.0)
	assert result.unjudged == []
	assert set(filtered['shots']) == set(result.kept)
	assert set(filtered['rig_instances']) == set(result.kept)
	# Points and camera models are untouched; the input is not mutated.
	assert filtered['points'] == reconstruction['points']
	assert filtered['cameras'] == reconstruction['cameras']
	assert set(reconstruction['shots']) == set(angles)


def test_filter_leaves_reconstruction_without_measured_vertical_untouched():
	shots = {f's{i}': _shot(30.0, (i * 10.0, 0.0, 100.0)) for i in range(6)}
	reconstruction = {'cameras': {}, 'shots': shots, 'points': {}}

	(filtered,), result = filter_reconstructions_by_orientation([reconstruction], max_off_nadir_degrees=10.0)

	assert filtered is reconstruction
	assert sorted(result.unjudged) == sorted(shots)
	assert result.kept == [] and result.excluded == []
	assert result.unjudged_reasons == ['6 shots: GPS positions lie on a single line']


def test_partials_from_opensfm_report_collects_bootstrap_and_grown_images():
	report = {
		'reconstructions': [
			{
				'bootstrap': {'image_pair': ['a.jpg', 'b.jpg']},
				'grow': {'steps': [{'images': ['c.jpg']}, {'images': ['d.jpg', 'e.jpg']}]},
			},
			{'bootstrap': {'image_pair': ['x.jpg', 'y.jpg']}, 'grow': {'steps': []}},
			{'bootstrap': {'decision': 'Failed'}},
		],
		'not_reconstructed_images': ['z.jpg'],
	}

	assert partials_from_opensfm_report(report) == [{'a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'}, {'x.jpg', 'y.jpg'}]


def test_filter_judges_merged_partial_reconstructions_separately():
	"""Two 2-image partials far apart look well spread once merged, but each was aligned from two positions."""
	shots = {
		'p0_a': _shot(0.0, (-24.3, 96.9, 116.6)),
		'p0_b': _shot(33.4, (13.7, 82.3, 120.9)),
		'p1_a': _shot(0.0, (73.1, -30.9, 116.2)),
		'p1_b': _shot(0.0, (24.4, -30.3, 116.2)),
	}
	reconstruction = {'cameras': {}, 'shots': shots, 'points': {}}

	(filtered,), result = filter_reconstructions_by_orientation(
		[reconstruction], max_off_nadir_degrees=10.0, partials=[{'p0_a', 'p0_b'}, {'p1_a', 'p1_b'}]
	)

	assert filtered is reconstruction
	assert sorted(result.unjudged) == sorted(shots)
	assert result.excluded == []
	assert result.unjudged_reasons == ['2 shots: only 2 shots have GPS positions'] * 2


def test_filter_trusts_a_well_spread_partial_next_to_an_unmeasured_one():
	area = _grid_reconstruction({'a1': 2.0, 'a2': 30.0, 'a3': 1.0, 'a4': 3.0, 'a5': 2.0})
	area['shots']['pair_a'] = _shot(50.0, (500.0, 500.0, 100.0))
	area['shots']['pair_b'] = _shot(50.0, (520.0, 500.0, 100.0))
	partials = [{'a1', 'a2', 'a3', 'a4', 'a5'}, {'pair_a', 'pair_b'}]

	(filtered,), result = filter_reconstructions_by_orientation([area], max_off_nadir_degrees=10.0, partials=partials)

	assert sorted(result.kept) == ['a1', 'a3', 'a4', 'a5']
	assert [shot_id for shot_id, _ in result.excluded] == ['a2']
	assert sorted(result.unjudged) == ['pair_a', 'pair_b']
	assert set(filtered['shots']) == {'a1', 'a3', 'a4', 'a5', 'pair_a', 'pair_b'}


def test_filter_leaves_shots_missing_from_the_report_unjudged():
	area = _grid_reconstruction({'a1': 2.0, 'a2': 30.0, 'a3': 1.0, 'a4': 3.0, 'a5': 2.0, 'a6': 4.0})
	partials = [{'a1', 'a3', 'a4', 'a5', 'a6'}]

	_, result = filter_reconstructions_by_orientation([area], max_off_nadir_degrees=10.0, partials=partials)

	assert sorted(result.kept) == ['a1', 'a3', 'a4', 'a5', 'a6']
	assert result.unjudged == ['a2']


def test_filter_distrusts_a_partial_with_a_camera_looking_above_the_horizon():
	reconstruction = _grid_reconstruction({'a': 13.0, 'b': 19.0, 'c': 97.0, 'd': 124.0, 'e': 133.0})

	(filtered,), result = filter_reconstructions_by_orientation([reconstruction], max_off_nadir_degrees=10.0)

	assert filtered is reconstruction
	assert sorted(result.unjudged) == ['a', 'b', 'c', 'd', 'e']
	assert result.unjudged_reasons == ['5 shots: a camera was reconstructed looking above the horizon']


def test_filter_judges_each_partial_reconstruction_in_its_own_frame():
	area = _grid_reconstruction({'a1': 2.0, 'a2': 30.0, 'a3': 1.0, 'a4': 3.0, 'a5': 2.0})
	line = {'shots': {f'l{i}': _shot(40.0, (i * 10.0, 0.0, 100.0)) for i in range(4)}}

	filtered, result = filter_reconstructions_by_orientation([area, line], max_off_nadir_degrees=10.0)

	assert sorted(result.kept) == ['a1', 'a3', 'a4', 'a5']
	assert [shot_id for shot_id, _ in result.excluded] == ['a2']
	assert sorted(result.unjudged) == ['l0', 'l1', 'l2', 'l3']
	assert set(filtered[1]['shots']) == set(line['shots'])


def test_filter_reports_all_oblique_flight_as_nothing_kept():
	reconstruction = _grid_reconstruction({f's{i}': 25.0 for i in range(8)})

	(filtered,), result = filter_reconstructions_by_orientation([reconstruction], max_off_nadir_degrees=10.0)

	assert result.kept == []
	assert len(result.excluded) == 8
	assert filtered['shots'] == {}


def test_filter_rejects_invalid_threshold():
	with pytest.raises(ValueError):
		filter_reconstructions_by_orientation([], max_off_nadir_degrees=-1.0)


def test_unjudged_shots_fall_back_to_metadata():
	"""A straight-line flight (dataset 9671) cannot be judged geometrically; metadata decides instead."""
	shots = {f's{i}': _shot(3.0, (i * 10.0, 0.0, 100.0)) for i in range(4)}
	reconstruction = {'cameras': {}, 'shots': shots, 'points': {}}
	metadata = {'s0': 80.2, 's1': 10.05, 's2': None}  # s3 has no metadata at all

	(filtered,), result = filter_reconstructions_by_orientation(
		[reconstruction], max_off_nadir_degrees=10.0, metadata_off_nadir=metadata
	)

	assert result.excluded_by_metadata == [('s0', 80.2)]
	assert sorted(result.unjudged) == ['s1', 's2', 's3']
	assert set(filtered['shots']) == {'s1', 's2', 's3'}
	assert result.kept == [] and result.excluded == []


def test_metadata_is_ignored_where_the_reconstruction_measures_the_vertical():
	reconstruction = _grid_reconstruction({k: 2.0 for k in 'abcdefgh'})

	_, result = filter_reconstructions_by_orientation(
		[reconstruction], max_off_nadir_degrees=10.0, metadata_off_nadir={k: 90.0 for k in 'abcdefgh'}
	)

	assert sorted(result.kept) == list('abcdefgh')
	assert result.excluded_by_metadata == []
