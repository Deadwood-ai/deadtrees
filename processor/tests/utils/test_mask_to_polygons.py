"""Polygonizing a class traces exactly what an unmasked GDAL trace gives for that class."""

import numpy as np
import pytest
import rasterio
from rasterio.features import shapes
from rasterio.transform import from_origin
from shapely.geometry import shape

from processor.src.utils.segmentation import mask_to_polygons_scanline

pytestmark = pytest.mark.unit


def _class_map(tmp_path):
	rng = np.random.default_rng(3)
	classes = rng.choice([0, 1, 2], size=(120, 90), p=[0.3, 0.5, 0.2]).astype(np.uint8)
	classes[20:80, 10:70] = 1
	classes[30:50, 20:40] = 0  # a hole
	classes[35:40, 25:30] = 2  # an island in the hole
	classes[90:110, 72:88] = 2
	classes[95:105, 76:84] = 0  # a hole in deadwood
	path = tmp_path / 'classes.tif'
	with rasterio.open(
		path, 'w', driver='GTiff', width=90, height=120, count=1, dtype='uint8', crs='EPSG:32632',
		transform=from_origin(400000.0, 5300000.0, 0.05, 0.05),
	) as dst:
		dst.write(classes, 1)
	return path


@pytest.mark.parametrize('class_value', [1, 2])
def test_class_polygons_match_an_unmasked_trace(tmp_path, class_value):
	with rasterio.open(_class_map(tmp_path)) as ds:
		expected = [shape(g) for g, v in shapes(ds.read(1), transform=ds.transform) if int(v) == class_value]
		polygons = mask_to_polygons_scanline(ds, class_value)

	assert expected and any(p.interiors for p in expected)
	assert [p.wkb for p in polygons] == [p.wkb for p in expected]


def test_the_background_is_not_polygonized(tmp_path):
	with rasterio.open(_class_map(tmp_path)) as ds, pytest.raises(ValueError):
		mask_to_polygons_scanline(ds, 0)
