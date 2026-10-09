"""Filter ODM/OpenSfM camera shots by their reconstructed orientation.

Camera-orientation metadata is unreliable across vendors (several DJI cameras
write ``GimbalPitchDegree=0`` for nadir shots), so the orthophoto filter uses
the orientation that OpenSfM reconstructs instead. The reconstruction is
expressed in a topocentric frame (x east, y north, z up) and each shot stores
a world-to-camera rotation as an angle-axis vector; the camera looks along its
+z axis.

The up axis is only *measured* when OpenSfM aligned the reconstruction to GPS
positions spread over an area. With no GPS, or GPS along a single line, OpenSfM
falls back to ``align_orientation_prior: vertical``, which rotates the world so
that the mean camera direction points down. Off-nadir angles in such a frame
say nothing about true obliqueness, so those shots are left untouched.

ODM merges OpenSfM's partial reconstructions into one before we see it
(``check_merge_partial_reconstructions``) and keeps no trace of which shot came
from which partial. Every partial was aligned on its own, so the up axis must be
judged per partial: two 2-image partials far apart look like a well-spread GPS
set once merged, yet each was aligned from two positions and its poses come
from the orientation prior. Partial membership is read from OpenSfM's
``reports/reconstruction.json``; see ``partials_from_opensfm_report``.
"""

from dataclasses import dataclass, field
from typing import Any

import numpy as np

# OpenSfM (opensfm/align.py, detect_alignment_constraints) switches from GPS
# alignment to the orientation prior when positions are this close to a line.
OPENSFM_LINE_EIGENVALUE_RATIO = 5e3
# Minimum GPS spread across the main flight direction (standard deviation, metres)
# for the GPS fit to pin down roll around that direction. Below this, altitude
# noise tilts the frame by degrees and the angles are not trustworthy.
MIN_CROSS_TRACK_SPREAD_M = 5.0
MIN_GPS_SHOTS = 3
# A drone camera never looks above the horizon; a partial with such a pose failed
# to reconstruct properly and none of its angles can be trusted.
MAX_PLAUSIBLE_OFF_NADIR_DEGREES = 90.0
# Metadata angles are rounded by the camera (e.g. GimbalPitchDegree=-79.97).
METADATA_TOLERANCE_DEGREES = 0.1


def rotation_matrix(rotation: Any) -> np.ndarray:
	"""World-to-camera rotation matrix from an OpenSfM angle-axis vector."""
	rotation_vector = np.asarray(rotation, dtype=float)
	angle = float(np.linalg.norm(rotation_vector))
	if angle < 1e-12:
		return np.eye(3)
	axis = rotation_vector / angle
	skew = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
	return np.eye(3) + np.sin(angle) * skew + (1 - np.cos(angle)) * skew @ skew


def camera_center(shot: dict) -> np.ndarray:
	"""Camera position in the topocentric frame: -R^T t."""
	return -rotation_matrix(shot['rotation']).T @ np.asarray(shot['translation'], dtype=float)


def off_nadir_degrees(rotation: Any) -> float:
	"""Angle between a shot's optical axis and straight down, from an angle-axis rotation."""
	# World-to-camera rotation: its third row is the optical axis in world coordinates.
	optical_axis_up_component = rotation_matrix(rotation)[2, 2]
	return float(np.degrees(np.arccos(np.clip(-optical_axis_up_component, -1.0, 1.0))))


def gps_defines_vertical(shots: list[dict]) -> tuple[bool, str]:
	"""Whether the up axis of a jointly aligned set of shots was measured from GPS rather than assumed."""
	# OpenSfM serializes the shot's GPS prior (topocentric metres) as a top-level shot field.
	positions = [shot['gps_position'] for shot in shots if 'gps_position' in shot]
	if len(positions) < MIN_GPS_SHOTS:
		return False, f'only {len(positions)} shots have GPS positions'

	centered = np.asarray(positions, dtype=float)
	centered = centered - centered.mean(axis=0)
	eigenvalues = np.sort(np.linalg.eigvalsh(centered.T @ centered))
	if eigenvalues[1] <= 0 or eigenvalues[2] / eigenvalues[1] > OPENSFM_LINE_EIGENVALUE_RATIO:
		return False, 'GPS positions lie on a single line'

	cross_track_spread_m = float(np.sqrt(eigenvalues[1] / len(positions)))
	if cross_track_spread_m < MIN_CROSS_TRACK_SPREAD_M:
		return False, f'GPS positions span only {cross_track_spread_m:.1f} m across the flight direction'
	return True, f'GPS positions span {cross_track_spread_m:.1f} m across the flight direction'


def partials_from_opensfm_report(report: dict) -> list[set[str]]:
	"""Image sets of OpenSfM's partial reconstructions, from ``opensfm/reports/reconstruction.json``."""
	partials = []
	for reconstruction in report.get('reconstructions', []):
		images = set(reconstruction.get('bootstrap', {}).get('image_pair', []))
		for step in reconstruction.get('grow', {}).get('steps', []):
			images.update(step.get('images', []))
		if images:
			partials.append(images)
	return partials


def _group_by_partial(shot_ids: list[str], partials: list[set[str]] | None) -> list[list[str]]:
	if partials is None:
		return [shot_ids]
	groups = [[shot_id for shot_id in shot_ids if shot_id in partial] for partial in partials]
	# Shots the report does not account for form single-shot groups, i.e. stay unjudged.
	assigned = set().union(*partials)
	groups.extend([shot_id] for shot_id in shot_ids if shot_id not in assigned)
	return [group for group in groups if group]


@dataclass
class OrientationFilterResult:
	kept: list[str] = field(default_factory=list)
	excluded: list[tuple[str, float]] = field(default_factory=list)
	# Shots of partial reconstructions without a measured up axis whose camera metadata
	# gives no usable angle either; they are kept.
	unjudged: list[str] = field(default_factory=list)
	unjudged_reasons: list[str] = field(default_factory=list)
	# Shots of such partials dropped because their camera metadata says they are oblique.
	excluded_by_metadata: list[tuple[str, float]] = field(default_factory=list)
	off_nadir: dict[str, float] = field(default_factory=dict)


def filter_reconstructions_by_orientation(
	reconstructions: list[dict],
	max_off_nadir_degrees: float,
	partials: list[set[str]] | None = None,
	metadata_off_nadir: dict[str, float | None] | None = None,
) -> tuple[list[dict], OrientationFilterResult]:
	"""Drop shots whose reconstructed optical axis is more than the threshold off nadir.

	Returns filtered copies of the reconstructions (points and cameras untouched,
	so the sparse cloud and camera models still benefit from the oblique views)
	and a report. ``partials`` are the image sets of OpenSfM's partial
	reconstructions; without them each reconstruction counts as one partial.
	Shots of partials without a GPS-measured up axis, or with implausible poses,
	fall back to ``metadata_off_nadir`` (off-nadir degrees from camera metadata per
	image, None when unknown): dropped when it says oblique, otherwise kept as unjudged.
	"""
	if not 0 <= max_off_nadir_degrees <= 90:
		raise ValueError('Maximum off-nadir angle must be between 0 and 90 degrees')

	result = OrientationFilterResult()
	filtered: list[dict] = []
	for reconstruction in reconstructions:
		shots = reconstruction.get('shots', {})
		angles = {shot_id: off_nadir_degrees(shot['rotation']) for shot_id, shot in shots.items()}
		result.off_nadir.update(angles)

		kept_shots = {}
		for shot_ids in _group_by_partial(list(shots), partials):
			measured, reason = gps_defines_vertical([shots[shot_id] for shot_id in shot_ids])
			if measured and max(angles[shot_id] for shot_id in shot_ids) > MAX_PLAUSIBLE_OFF_NADIR_DEGREES:
				measured, reason = False, 'a camera was reconstructed looking above the horizon'
			if not measured:
				result.unjudged_reasons.append(f'{len(shot_ids)} shots: {reason}')
				for shot_id in shot_ids:
					metadata_angle = (metadata_off_nadir or {}).get(shot_id)
					if (
						metadata_angle is not None
						and metadata_angle > max_off_nadir_degrees + METADATA_TOLERANCE_DEGREES
					):
						result.excluded_by_metadata.append((shot_id, metadata_angle))
					else:
						kept_shots[shot_id] = shots[shot_id]
						result.unjudged.append(shot_id)
				continue
			for shot_id in shot_ids:
				if angles[shot_id] <= max_off_nadir_degrees:
					kept_shots[shot_id] = shots[shot_id]
					result.kept.append(shot_id)
				else:
					result.excluded.append((shot_id, angles[shot_id]))

		filtered.append(_with_shots(reconstruction, kept_shots) if len(kept_shots) < len(shots) else reconstruction)

	return filtered, result


def _with_shots(reconstruction: dict, kept_shots: dict) -> dict:
	"""Copy of a reconstruction restricted to ``kept_shots``, keeping rig instances consistent."""
	updated = {**reconstruction, 'shots': kept_shots}
	if 'rig_instances' in reconstruction:
		rig_instances = {}
		for instance_id, instance in reconstruction['rig_instances'].items():
			rig_camera_ids = {
				shot_id: camera_id
				for shot_id, camera_id in instance.get('rig_camera_ids', {}).items()
				if shot_id in kept_shots
			}
			if rig_camera_ids:
				rig_instances[instance_id] = {**instance, 'rig_camera_ids': rig_camera_ids}
		updated['rig_instances'] = rig_instances
	return updated
