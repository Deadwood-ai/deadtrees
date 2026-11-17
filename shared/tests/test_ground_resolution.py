import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin

from shared.utils import ground_resolution_cm


def write_raster(path, crs, west, north, res_x, res_y):
	with rasterio.open(
		path,
		'w',
		driver='GTiff',
		width=64,
		height=64,
		count=1,
		dtype='uint8',
		crs=crs,
		transform=from_origin(west, north, res_x, res_y),
	) as dst:
		dst.write(np.zeros((1, 64, 64), dtype='uint8'))
	return path


@pytest.mark.parametrize(
	('crs', 'west', 'north', 'res_x', 'res_y', 'expected_cm'),
	[
		# UTM 32N on its central meridian at about 52.4°N: metres.
		('EPSG:32632', 500_000, 5_810_000, 0.03, 0.03, 3.0),
		# Degrees at 52.5°N: a degree of longitude is 0.61 of a degree of latitude, so
		# 5e-7 by 3e-7 degrees is 3.39 by 3.34 cm on the ground.
		('EPSG:4326', 13.4, 52.5, 5e-7, 3e-7, 3.4),
		# Web mercator stretches ground distance by 1/cos(latitude).
		('EPSG:3857', 1_491_000, 6_891_000, 0.05, 0.05, 3.0),
		# New York state plane in US survey feet.
		('EPSG:2263', 980_000, 200_000, 0.1, 0.1, 3.0),
	],
)
def test_ground_resolution_converts_crs_units_to_ground_cm(tmp_path, crs, west, north, res_x, res_y, expected_cm):
	path = write_raster(tmp_path / 'ortho.tif', crs, west, north, res_x, res_y)
	assert ground_resolution_cm(path) == pytest.approx(expected_cm, abs=0.1)


def test_local_crs_uses_its_linear_unit(tmp_path):
	local = CRS.from_wkt('LOCAL_CS["Arbitrary (m)",UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH]]')
	path = write_raster(tmp_path / 'ortho.tif', local, 0, 100, 0.04, 0.04)
	assert ground_resolution_cm(path) == pytest.approx(4.0)


def test_raster_without_crs_has_no_ground_resolution(tmp_path):
	path = write_raster(tmp_path / 'ortho.tif', None, 0, 100, 0.04, 0.04)
	assert ground_resolution_cm(path) is None
