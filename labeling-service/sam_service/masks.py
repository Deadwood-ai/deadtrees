"""Mask to polygon conversion for the editor.

The editor sends a JPEG of its map view and expects polygons in that image's pixel
space, with y negated (the contract of the earlier Modal service).
"""

import cv2
import numpy as np

MIN_AREA_PX = 16


def masks_to_geojson(masks: list[np.ndarray], scores: list[float] | None = None) -> dict:
	"""One polygon per connected part of each mask, holes included."""
	features = []
	for i, mask in enumerate(masks):
		contours, hierarchy = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
		if hierarchy is None:
			continue
		for j, contour in enumerate(contours):
			# RETR_CCOMP: outer rings have no parent; their holes name them as parent.
			if hierarchy[0][j][3] != -1 or not _usable(contour):
				continue
			rings = [_ring(contour)]
			rings += [_ring(hole) for k, hole in enumerate(contours) if hierarchy[0][k][3] == j and _usable(hole)]
			properties = {'mask_id': i, 'contour_id': j}
			if scores is not None:
				properties['score'] = round(float(scores[i]), 3)
			features.append(
				{'type': 'Feature', 'geometry': {'type': 'Polygon', 'coordinates': rings}, 'properties': properties}
			)
	return {'type': 'FeatureCollection', 'features': features}


def _usable(contour: np.ndarray) -> bool:
	return len(contour) >= 3 and cv2.contourArea(contour) >= MIN_AREA_PX


def _ring(contour: np.ndarray) -> list[list[float]]:
	ring = [[float(p[0][0]), float(-p[0][1])] for p in contour]
	return ring + [ring[0]]
