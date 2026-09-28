"""Remove sparse points that no remaining shot observes. Runs *inside* the ODM image.

After oblique shots are dropped from ``opensfm/reconstruction.json``, OpenSfM's
undistortion keeps only the remaining shots' track observations and
``export_visualsfm`` then fails on points that lost all of them. Observations
live in ``opensfm/tracks.csv``, which ODM's OpenSfM writes in a private binary
format, so this script reads it with OpenSfM itself. The processor passes the
source of this file to ``python3 -c`` in an ODM container (see
``process_odm._prune_unobserved_points``); it must stay self-contained and depend
only on the standard library plus the ``opensfm`` package shipped in that image.

Usage: python3 -c "<this file>" <opensfm project directory>
"""

import json
import os
import sys


def unobserved_point_ids(reconstruction: dict, observed_track_ids: set) -> list:
	return [point_id for point_id in reconstruction.get('points', {}) if point_id not in observed_track_ids]


def main(opensfm_dir: str) -> None:
	from opensfm.dataset import DataSet

	tracks_manager = DataSet(opensfm_dir).load_tracks_manager()
	path = os.path.join(opensfm_dir, 'reconstruction.json')
	with open(path) as reconstruction_file:
		reconstructions = json.load(reconstruction_file)

	removed = total = 0
	for reconstruction in reconstructions:
		observed = set()
		for shot_id in reconstruction.get('shots', {}):
			observed.update(tracks_manager.get_shot_observations(shot_id))
		stale = unobserved_point_ids(reconstruction, observed)
		total += len(reconstruction.get('points', {}))
		removed += len(stale)
		for point_id in stale:
			del reconstruction['points'][point_id]

	with open(f'{path}.tmp', 'w') as reconstruction_file:
		json.dump(reconstructions, reconstruction_file)
	os.replace(f'{path}.tmp', path)
	print(json.dumps({'removed_points': removed, 'total_points': total}))


if __name__ == '__main__':
	main(sys.argv[1])
