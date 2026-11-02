import numpy as np
from sam_service.masks import masks_to_geojson


def test_outline_keeps_holes_and_negates_y():
	mask = np.zeros((60, 60), bool)
	mask[10:50, 10:50] = True
	mask[25:35, 25:35] = False
	fc = masks_to_geojson([mask], scores=[0.876])
	(feature,) = fc['features']
	outer, hole = feature['geometry']['coordinates']
	assert all(y <= 0 for _, y in outer)
	assert outer[0] == outer[-1] and hole[0] == hole[-1]
	assert min(-y for _, y in hole) >= 24
	assert feature['properties'] == {'mask_id': 0, 'contour_id': feature['properties']['contour_id'], 'score': 0.876}


def test_specks_and_empty_masks_are_dropped():
	speck = np.zeros((20, 20), bool)
	speck[5:7, 5:7] = True
	assert masks_to_geojson([speck, np.zeros((20, 20), bool)])['features'] == []
