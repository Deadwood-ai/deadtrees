"""Cut a reconstructed ODM project into overlapping submodels for split-merge. Runs *inside* the ODM image.

ODM's split-merge (stages/splitmerge.py) normally clusters the images, then matches and
reconstructs every submodel on its own and aligns them. The processor already has one
reconstruction of the whole mission from pass 1, with oblique shots filtered out
(DT-1491). This script hands each submodel its part of that reconstruction instead, so
the split ODM run skips straight to undistortion, meshing, texturing and the orthophoto
per submodel, all in the frame of the whole mission:

- the kept shots are clustered by their reconstructed camera position with OpenSfM's
  k-means (``opensfm.large.tools.kmeans``, as ``create_submodels`` does with GPS), and
  each cluster takes in every shot within the overlap radius, like
  ``tools.add_cluster_neighbors``;
- ``MetaDataSet.create_submodels`` lays out the submodel folders (image symlinks and
  symlinks to the parent's exif, features and matches);
- each submodel gets the parent's ``reconstruction.json`` reduced to its shots and the
  points they observe, and a symlink to the parent's ``tracks.csv``. ODM then finds both
  and does not reconstruct the submodel again (``OSFMContext.create_tracks`` and
  ``reconstruct`` skip existing files).

The processor passes the source of this file to ``python3 -c`` in an ODM container (see
``process_odm._split_into_pieces``); it must stay self-contained and depend only on the
standard library, numpy and the ``opensfm`` package shipped in that image.

Usage: python3 -c "<this file>" <opensfm project directory> <pieces> <overlap metres>
"""

import json
import os
import sys

import numpy as np

# A piece needs a few cameras for a mesh and an orthophoto of its own.
MIN_PIECE_SHOTS = 3


def odm_split_config(images_per_piece: int, overlap_m: float) -> dict:
	"""What ODM's split stage appends to OpenSfM's config.yaml, so its MetaDataSet finds these submodels."""
	return {
		'submodels_relpath': '../submodels/opensfm',
		'submodel_relpath_template': '../submodels/submodel_%04d/opensfm',
		'submodel_images_relpath_template': '../submodels/submodel_%04d/images',
		'submodel_size': images_per_piece,
		'submodel_overlap': overlap_m,
	}


def camera_center(shot: dict) -> np.ndarray:
	"""Camera position of an OpenSfM shot: -R^T t, with R from the axis-angle ``rotation``."""
	rotation = np.asarray(shot['rotation'], dtype=float)
	angle = np.linalg.norm(rotation)
	if angle == 0:
		matrix = np.eye(3)
	else:
		k = rotation / angle
		cross = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
		matrix = np.eye(3) + np.sin(angle) * cross + (1 - np.cos(angle)) * cross @ cross
	return -matrix.T @ np.asarray(shot['translation'], dtype=float)


def pieces_with_overlap(positions: np.ndarray, labels: np.ndarray, overlap_m: float) -> list[list[int]]:
	"""Indices per cluster label, each widened by every position within ``overlap_m`` of a member."""
	pieces = []
	for label in np.unique(labels):
		members = positions[labels == label]
		near = np.zeros(len(positions), dtype=bool)
		for start in range(0, len(members), 256):
			chunk = members[start : start + 256]
			distances = np.linalg.norm(positions[:, None, :] - chunk[None, :, :], axis=2)
			near |= (distances <= overlap_m).any(axis=1)
		pieces.append(sorted(set(np.flatnonzero(labels == label)) | set(np.flatnonzero(near))))
	return pieces


def piece_reconstructions(reconstructions: list, shot_ids: set, observed_track_ids) -> list:
	"""The partial reconstructions reduced to ``shot_ids`` and the points those shots observe.

	OpenSfM's export fails on points without a remaining observation (see odm_prune_points.py).
	"""
	result = []
	for reconstruction in reconstructions:
		shots = {shot_id: shot for shot_id, shot in reconstruction.get('shots', {}).items() if shot_id in shot_ids}
		if not shots:
			continue
		observed = set()
		for shot_id in shots:
			observed.update(observed_track_ids(shot_id))
		points = {point_id: point for point_id, point in reconstruction.get('points', {}).items() if point_id in observed}
		result.append({**reconstruction, 'shots': shots, 'points': points})
	return result


def _append_config(opensfm_dir: str, values: dict) -> None:
	path = os.path.join(opensfm_dir, 'config.yaml')
	existing = ''
	if os.path.exists(path):
		with open(path) as config_file:
			existing = config_file.read()
	kept = [line for line in existing.splitlines() if line.split(':', 1)[0].strip() not in values]
	with open(path, 'w') as config_file:
		config_file.write('\n'.join(kept + [f'{key}: {value}' for key, value in values.items()]) + '\n')


def main(opensfm_dir: str, pieces: int, overlap_m: float) -> None:
	from opensfm.dataset import DataSet
	from opensfm.large import tools
	from opensfm.large.metadataset import MetaDataSet

	with open(os.path.join(opensfm_dir, 'reconstruction.json')) as reconstruction_file:
		reconstructions = json.load(reconstruction_file)
	shot_ids = [shot_id for reconstruction in reconstructions for shot_id in reconstruction.get('shots', {})]
	positions = np.array(
		[camera_center(shot)[:2] for reconstruction in reconstructions for shot in reconstruction.get('shots', {}).values()],
		dtype=np.float32,
	)
	if pieces < 2 or len(shot_ids) < pieces * MIN_PIECE_SHOTS:
		raise SystemExit(f'Cannot cut {len(shot_ids)} shots into {pieces} pieces')

	_append_config(opensfm_dir, odm_split_config(-(-len(shot_ids) // pieces), overlap_m))
	labels = tools.kmeans(positions, pieces)[1].ravel()
	clusters = pieces_with_overlap(positions, labels, overlap_m)
	too_small = [len(cluster) for cluster in clusters if len(cluster) < MIN_PIECE_SHOTS]
	if len(clusters) != pieces or too_small:
		raise SystemExit(f'Clustering {len(shot_ids)} shots gave pieces of {[len(c) for c in clusters]} shots')

	meta_data = MetaDataSet(opensfm_dir)
	meta_data.remove_submodels()
	meta_data = MetaDataSet(opensfm_dir)
	meta_data.create_submodels([[shot_ids[i] for i in cluster] for cluster in clusters])

	tracks_manager = DataSet(opensfm_dir).load_tracks_manager()
	tracks_path = os.path.join(opensfm_dir, 'tracks.csv')
	own_shots = [int((labels == label).sum()) for label in np.unique(labels)]
	summary = []
	for index, cluster in enumerate(clusters):
		submodel_dir = meta_data._submodel_path(index)
		piece = piece_reconstructions(
			reconstructions, {shot_ids[i] for i in cluster}, lambda shot: tracks_manager.get_shot_observations(shot).keys()
		)
		with open(os.path.join(submodel_dir, 'reconstruction.json'), 'w') as reconstruction_file:
			json.dump(piece, reconstruction_file)
		os.symlink(os.path.relpath(tracks_path, submodel_dir), os.path.join(submodel_dir, 'tracks.csv'))
		summary.append(
			{
				'shots': sum(len(r['shots']) for r in piece),
				'own_shots': own_shots[index],
				'points': sum(len(r['points']) for r in piece),
			}
		)
	print(json.dumps({'pieces': summary}))


if __name__ == '__main__':
	main(sys.argv[1], int(sys.argv[2]), float(sys.argv[3]))
