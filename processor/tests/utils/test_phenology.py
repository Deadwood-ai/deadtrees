import pytest
from processor.src.utils.phenology import get_phenology_curve, get_phenology_metadata
from shared.models import PhenologyMetadata

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

# Test points where no phenology data should exist (ocean locations)
TEST_POINTS_NO_DATA = [
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


@pytest.mark.parametrize('lat,lon', TEST_POINTS_NO_DATA)
def test_get_phenology_curve_no_data(lat, lon):
	"""Test phenology curve retrieval for ocean locations (should return None)"""
	curve = get_phenology_curve(lat, lon)
	# Ocean locations should return None (no phenology data)
	assert curve is None


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


def test_get_phenology_metadata_no_data():
	"""Test phenology metadata creation for ocean location (no data)"""
	# Test with ocean coordinates (should have no data)
	lat, lon = 30.0, -30.0
	metadata = get_phenology_metadata(lat, lon)
	assert metadata is None


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
