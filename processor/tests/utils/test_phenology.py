import xarray as xr

import pytest
from processor.src.utils.phenology import (
	get_phenology_curve,
	get_phenology_metadata,
	get_phenology_path,
	_find_nearest_valid_index,
)
from shared.models import PhenologyMetadata

pytestmark = pytest.mark.usefixtures('ensure_phenology_data')

# Test data points (real coordinates where phenology data should exist)
TEST_POINTS_WITH_DATA = [
	# Black Forest, Germany (temperate forest)
	(48.0, 8.0),
	# Eastern Canada (temperate forest)
	(45.0, -75.0),
	# Northern Michigan, USA (temperate forest)
	(45.8, -84.5),
	# Central Europe (temperate)
	(50.0, 10.0),
]

# Coastal / island / tropical sites whose centroid lands on a masked MODIS pixel but which
# have valid phenology nearby. These previously returned None; the nearest-valid fallback
# should now recover them. (lat, lon) of real affected datasets.
TEST_POINTS_FALLBACK = [
	# Scotland (dataset 310)
	(57.5520, -4.8183),
	# Antigua, Caribbean (dataset 909/8164)
	(17.0075, -61.7625),
	# Seychelles (dataset 1167)
	(-4.7591, 55.4808),
	# Santiago, Chile (dataset 214)
	(-33.4132, -70.3250),
]

# Open-ocean locations far from any land. With the unbounded nearest-valid fallback these no
# longer return None: every coordinate resolves to the globally nearest valid (land) pixel.
TEST_POINTS_REMOTE = [
	# Atlantic Ocean
	(30.0, -30.0),
	# Pacific Ocean
	(0.0, -150.0),
]


@pytest.mark.parametrize('lat,lon', TEST_POINTS_WITH_DATA)
def test_get_phenology_curve_with_data(lat, lon):
	"""Test phenology curve retrieval for locations with expected data"""
	curve = get_phenology_curve(lat, lon)

	assert isinstance(curve, list)
	assert len(curve) == 366
	assert all(isinstance(val, int) for val in curve)
	assert all(0 <= val <= 255 for val in curve)
	# Should have some variation (not all same values)
	assert len(set(curve)) > 1


@pytest.mark.parametrize('lat,lon', TEST_POINTS_FALLBACK)
def test_get_phenology_curve_nearest_valid_fallback(lat, lon):
	"""Coastal/island sites whose nearest pixel is masked should resolve via the fallback."""
	curve = get_phenology_curve(lat, lon)

	assert isinstance(curve, list), f'Expected fallback to recover phenology at ({lat}, {lon})'
	assert len(curve) == 366
	assert all(isinstance(val, int) for val in curve)
	assert all(0 <= val <= 255 for val in curve)
	assert len(set(curve)) > 1


@pytest.mark.parametrize('lat,lon', TEST_POINTS_REMOTE)
def test_get_phenology_curve_always_resolves(lat, lon):
	"""Even remote open-ocean coordinates resolve to the globally nearest valid pixel."""
	curve = get_phenology_curve(lat, lon)

	assert isinstance(curve, list), f'Expected a curve for ({lat}, {lon}); fallback should always resolve'
	assert len(curve) == 366
	assert all(0 <= val <= 255 for val in curve)


def test_find_nearest_valid_index_returns_valid_pixel():
	"""For a masked-centroid site, the helper returns an index that is not masked."""
	from rasterio import crs, warp
	from processor.src.utils.phenology import MODIS_CRS

	# Scotland centroid (nearest pixel is masked)
	lat, lon = 57.5520, -4.8183
	x, y = warp.transform(crs.CRS.from_epsg(4326), MODIS_CRS, [lon], [lat])

	ds = xr.open_zarr(get_phenology_path())
	index = _find_nearest_valid_index(ds, x[0], y[0])

	assert index is not None
	yi, xi = index
	assert not bool(ds.nan_mask.isel(y=yi, x=xi).values)


def test_find_nearest_valid_index_open_ocean_resolves():
	"""An open-ocean centroid still resolves to the globally nearest valid (land) pixel."""
	from rasterio import crs, warp
	from processor.src.utils.phenology import MODIS_CRS

	lat, lon = 30.0, -30.0  # mid-Atlantic, no valid pixel nearby
	x, y = warp.transform(crs.CRS.from_epsg(4326), MODIS_CRS, [lon], [lat])

	ds = xr.open_zarr(get_phenology_path())
	index = _find_nearest_valid_index(ds, x[0], y[0])

	assert index is not None
	yi, xi = index
	assert not bool(ds.nan_mask.isel(y=yi, x=xi).values)


def test_get_phenology_metadata_success():
	"""Test phenology metadata creation for a location with data"""
	# Test with Black Forest coordinates (should have data)
	lat, lon = 48.0, 8.0
	metadata = get_phenology_metadata(lat, lon)

	# if metadata is not None:
	assert isinstance(metadata, PhenologyMetadata)
	assert len(metadata.phenology_curve) == 366
	assert metadata.source == 'MODIS Phenology'
	assert metadata.version == '1.0'


def test_get_phenology_metadata_remote_resolves():
	"""Remote ocean coordinates now resolve to nearest-land phenology instead of None."""
	# Mid-Atlantic; with the unbounded fallback this resolves to the nearest valid pixel.
	lat, lon = 30.0, -30.0
	metadata = get_phenology_metadata(lat, lon)
	assert isinstance(metadata, PhenologyMetadata)
	assert len(metadata.phenology_curve) == 366


def test_create_metadata_valid():
	"""Test creating metadata with valid curve"""
	curve = list(range(366))
	metadata = PhenologyMetadata(phenology_curve=curve)

	assert metadata.phenology_curve == curve
	assert metadata.source == 'MODIS Phenology'
	assert metadata.version == '1.0'


def test_create_metadata_invalid_length():
	"""Test creating metadata with invalid curve length"""
	with pytest.raises(ValueError, match='must have exactly 366 values'):
		PhenologyMetadata(phenology_curve=[1, 2, 3])


def test_create_metadata_empty_curve():
	"""Test creating metadata with empty curve"""
	with pytest.raises(ValueError, match='must have exactly 366 values'):
		PhenologyMetadata(phenology_curve=[])
