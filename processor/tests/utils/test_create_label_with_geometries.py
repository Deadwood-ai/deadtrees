import pytest
from pathlib import Path
import geopandas as gpd
from shapely.geometry import Polygon, MultiPolygon, shape
import shutil

from shared.db import use_client
from shared.settings import settings
from shared.models import (
	LabelPayloadData,
	LabelSourceEnum,
	LabelTypeEnum,
	LabelDataEnum,
	PlatformEnum,
	LicenseEnum,
	DatasetAccessEnum,
)
from shared.labels import create_label_with_geometries


@pytest.fixture
def test_geometries():
	"""Create test geometries that will exceed the chunk size"""
	# Create a base polygon
	base_polygon = Polygon([(0, 0), (0, 1), (1, 1), (1, 0), (0, 0)])

	# Create multiple polygons with slight offsets to simulate real data
	polygons = []
	for i in range(100):  # Create enough polygons to exceed chunk size
		polygons.append(Polygon([(x + i * 1.1, y) for x, y in base_polygon.exterior.coords]))

	return MultiPolygon(polygons)


@pytest.fixture
def test_dataset_with_label(auth_token, data_directory, test_file, test_processor_user):
	"""Create a temporary test dataset for label testing"""
	with use_client(auth_token) as client:
		# Copy test file to archive directory
		file_name = 'test-labels-geom.tif'
		archive_path = data_directory / settings.ARCHIVE_DIR / file_name
		shutil.copy2(test_file, archive_path)

		# Create test dataset
		dataset_data = {
			'file_name': file_name,
			'user_id': test_processor_user,
			'license': LicenseEnum.cc_by.value,
			'platform': PlatformEnum.drone.value,
			'authors': ['Test Author'],
			'data_access': DatasetAccessEnum.public.value,
			'aquisition_year': 2024,
			'aquisition_month': 1,
			'aquisition_day': 1,
		}
		response = client.table(settings.datasets_table).insert(dataset_data).execute()
		dataset_id = response.data[0]['id']

		try:
			yield dataset_id
		finally:
			# Cleanup database entries
			client.table(settings.labels_table).delete().eq('dataset_id', dataset_id).execute()
			client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()
			# Cleanup file
			if archive_path.exists():
				archive_path.unlink()


@pytest.mark.asyncio
async def test_create_label_with_chunked_geometries(
	test_dataset_with_label, test_geometries, test_processor_user, auth_token
):
	"""Test creating a label with geometries that exceed chunk size"""
	# Create label payload
	payload = LabelPayloadData(
		dataset_id=test_dataset_with_label,
		label_source=LabelSourceEnum.visual_interpretation,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.deadwood,
		label_quality=1,
		geometry=test_geometries.__geo_interface__,
		properties={'test': 'property'},
		# AOI fields
		aoi_geometry=test_geometries.__geo_interface__,
		aoi_image_quality=1,
		aoi_notes='Test AOI',
	)

	# Create label
	label = await create_label_with_geometries(payload, test_processor_user, auth_token)

	# Verify label was created
	assert label.dataset_id == test_dataset_with_label
	assert label.user_id == test_processor_user
	assert label.label_source == LabelSourceEnum.visual_interpretation
	assert label.label_type == LabelTypeEnum.segmentation
	assert label.label_data == LabelDataEnum.deadwood
	assert label.label_quality == 1

	# Verify geometries were saved correctly
	with use_client(auth_token) as client:
		# Check AOI
		aoi_response = client.table(settings.aois_table).select('*').eq('id', label.aoi_id).execute()
		assert len(aoi_response.data) == 1
		assert aoi_response.data[0]['image_quality'] == 1
		assert aoi_response.data[0]['notes'] == 'Test AOI'

		# Check geometries
		geom_response = client.table(settings.deadwood_geometries_table).select('*').eq('label_id', label.id).execute()

		# Verify all geometries were saved (should be multiple chunks)
		all_geometries = []
		for geom_record in geom_response.data:
			assert geom_record['properties'] == {'test': 'property'}
			all_geometries.append(shape(geom_record['geometry']))

		# Combine all geometries and compare with original
		# combined_geom = MultiPolygon(all_geometries)
		# assert combined_geom == test_geometries


@pytest.mark.asyncio
async def test_create_label_with_real_geometries(test_dataset_with_label, test_processor_user, auth_token):
	"""Test creating a label with geometries from a real GeoPackage file"""
	# Load geometries from test GeoPackage
	test_file = (
		Path(__file__).parent.parent.parent.parent
		/ 'assets'
		/ 'test_data'
		/ 'label_upload'
		/ 'yanspain_crop_124_polygons.gpkg'
	)

	# Read both layers
	deadwood = gpd.read_file(test_file, layer='standing_deadwood').to_crs(epsg=4326)
	aoi = gpd.read_file(test_file, layer='aoi').to_crs(epsg=4326)

	# Convert deadwood geometries to MultiPolygon GeoJSON
	deadwood_geojson = {
		'type': 'MultiPolygon',
		'coordinates': [
			[[[float(x), float(y)] for x, y in poly.exterior.coords]]
			for geom in deadwood.geometry
			for poly in (geom if isinstance(geom, MultiPolygon) else [geom])
		],
	}

	# Convert AOI to MultiPolygon GeoJSON
	aoi_geojson = {
		'type': 'MultiPolygon',
		'coordinates': [
			[[[float(x), float(y)] for x, y in poly.exterior.coords]]
			for geom in aoi.geometry
			for poly in (geom if isinstance(geom, MultiPolygon) else [geom])
		],
	}

	# Create label payload
	payload = LabelPayloadData(
		dataset_id=test_dataset_with_label,
		label_source=LabelSourceEnum.model_prediction,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.deadwood,
		label_quality=3,
		geometry=deadwood_geojson,
		properties={'source': 'test_prediction'},
		aoi_geometry=aoi_geojson,
		aoi_image_quality=1,
		aoi_notes='Test AOI from real data',
	)

	# Create label
	label = await create_label_with_geometries(payload, test_processor_user, auth_token)

	# Verify label was created
	assert label.dataset_id == test_dataset_with_label
	assert label.user_id == test_processor_user
	assert label.label_source == LabelSourceEnum.model_prediction
	assert label.label_type == LabelTypeEnum.segmentation
	assert label.label_data == LabelDataEnum.deadwood
	assert label.label_quality == 3

	# Verify geometries were saved correctly
	with use_client(auth_token) as client:
		# Check AOI
		aoi_response = client.table(settings.aois_table).select('*').eq('id', label.aoi_id).execute()
		assert len(aoi_response.data) == 1
		assert aoi_response.data[0]['image_quality'] == 1
		assert aoi_response.data[0]['notes'] == 'Test AOI from real data'

		# Check geometries
		geom_response = client.table(settings.deadwood_geometries_table).select('*').eq('label_id', label.id).execute()

		# Verify all geometries were saved
		all_geometries = []
		for geom_record in geom_response.data:
			assert geom_record['properties'] == {'source': 'test_prediction'}
			all_geometries.append(shape(geom_record['geometry']))

		# Verify we have geometries
		assert len(all_geometries) > 0
