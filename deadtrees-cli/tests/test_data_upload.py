import shutil
import pytest
from pathlib import Path
from shared.db import use_client
from shared.settings import settings
from shared.models import StatusEnum
from shared.testing.fixtures import (
	test_file,
	auth_token,
	cleanup_database,
	test_processor_user,
)
from deadtrees_cli.data import DataCommands
import geopandas as gpd
from shapely.geometry import Polygon, MultiPolygon
from shared.models import LabelSourceEnum, LabelTypeEnum, LabelDataEnum


@pytest.fixture(scope='function')
def test_dataset_for_upload(auth_token, data_directory, test_file, test_processor_user):
	"""Create a temporary test dataset for upload testing"""
	with use_client(auth_token) as client:
		# Create test dataset
		dataset_data = {
			'file_name': test_file.name,
			'user_id': test_processor_user,
			'license': 'CC BY',
			'platform': 'drone',
			'authors': ['Test Author'],
			'data_access': 'public',
			'aquisition_year': 2024,
		}

		# Insert dataset and get ID
		response = client.table(settings.datasets_table).insert(dataset_data).execute()
		dataset_id = response.data[0]['id']

		# Create ortho entry
		ortho_data = {
			'dataset_id': dataset_id,
			'ortho_file_name': test_file.name,
			'version': 1,
			'ortho_file_size': max(1, int((test_file.stat().st_size / 1024 / 1024))),  # in MB
			'ortho_upload_runtime': 0.1,
			'ortho_info': {'Driver': 'GTiff', 'Size': [1024, 1024]},
		}
		client.table(settings.orthos_table).insert(ortho_data).execute()

		# Create status entry
		status_data = {
			'dataset_id': dataset_id,
			'current_status': StatusEnum.idle.value,
			'is_upload_done': True,
			'is_ortho_done': True,
		}
		client.table(settings.statuses_table).insert(status_data).execute()

		try:
			yield dataset_id
		finally:
			# Cleanup database entries
			client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
			client.table(settings.orthos_table).delete().eq('dataset_id', dataset_id).execute()
			client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


@pytest.fixture
def data_commands():
	"""Create a DataCommands instance for testing"""
	return DataCommands()


def test_upload_basic(data_commands, test_file):
	"""Test basic file upload with minimal parameters"""
	try:
		result = data_commands.upload(
			file_path=str(test_file),
			authors=['Test Author'],
			platform='drone',
			data_access='public',
			aquisition_year=2024,
		)

		assert result is not None
		assert 'id' in result
		dataset_id = result['id']

		# Verify dataset was created in database
		token = data_commands._ensure_auth()
		with use_client(token) as client:
			response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()
			assert len(response.data) == 1
			dataset = response.data[0]
			assert dataset['file_name'] == test_file.name

			# Check status
			status_response = client.table(settings.statuses_table).select('*').eq('dataset_id', dataset_id).execute()
			assert len(status_response.data) == 1
			status = status_response.data[0]
			assert status['is_upload_done'] is True
			assert status['current_status'] == StatusEnum.idle.value

	finally:
		# Cleanup
		if 'dataset_id' in locals():
			with use_client(token) as client:
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()

				# Clean up files
				# archive_path = settings.archive_path / f'{dataset_id}_ortho.tif'
				# if archive_path.exists():
				# archive_path.unlink()


def test_upload_with_metadata(data_commands, test_file):
	"""Test file upload with full metadata"""
	try:
		result = data_commands.upload(
			file_path=str(test_file),
			authors=['Test Author 1', 'Test Author 2'],
			platform='drone',
			data_access='public',
			license='CC BY',
			aquisition_year=2024,
			aquisition_month=1,
			aquisition_day=15,
			additional_information='Test upload with metadata',
			citation_doi='10.5281/zenodo.12345678',
		)

		assert result is not None
		dataset_id = result['id']

		# Verify metadata in database
		token = data_commands._ensure_auth()
		with use_client(token) as client:
			response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()
			dataset = response.data[0]
			assert dataset['authors'] == ['Test Author 1', 'Test Author 2']
			assert dataset['aquisition_year'] == 2024
			assert dataset['citation_doi'] == '10.5281/zenodo.12345678'

	finally:
		# Cleanup
		if 'dataset_id' in locals():
			with use_client(token) as client:
				client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()

				# Clean up files
				# archive_path = settings.archive_path / f'{dataset_id}_ortho.tif'
				# if archive_path.exists():
				# 	archive_path.unlink()


def test_upload_label(data_commands, test_dataset_for_upload):
	"""Test uploading labels from GeoDataFrames"""
	# Create test geometries
	file_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'yanspain_crop_124_polygons.gpkg'
	labels_gdf = gpd.read_file(file_path, layer='standing_deadwood').to_crs(epsg=4326)
	aoi_gdf = gpd.read_file(file_path, layer='aoi').to_crs(epsg=4326)

	# Upload label
	label = data_commands.upload_label(
		dataset_id=test_dataset_for_upload,
		labels_gdf=labels_gdf,
		label_source='visual_interpretation',
		label_type='segmentation',
		label_data='deadwood',
		label_quality=1,
		properties={'source': 'test_data'},
		aoi_gdf=aoi_gdf,
		aoi_image_quality=1,
		aoi_notes='Test AOI',
	)

	# Verify label was created correctly
	assert label.dataset_id == test_dataset_for_upload
	assert label.label_source == LabelSourceEnum.visual_interpretation
	assert label.label_type == LabelTypeEnum.segmentation
	assert label.label_data == LabelDataEnum.deadwood
	assert label.label_quality == 1


def test_upload_label_without_aoi(data_commands, test_dataset_for_upload):
	"""Test uploading labels without AOI"""
	file_path = Path(__file__).parent.parent.parent / 'assets' / 'test_data' / 'yanspain_crop_124_polygons.gpkg'
	labels_gdf = gpd.read_file(file_path, layer='standing_deadwood').to_crs(epsg=4326)

	# Upload label
	label = data_commands.upload_label(
		dataset_id=test_dataset_for_upload,
		labels_gdf=labels_gdf,
		label_source='visual_interpretation',
		label_type='segmentation',
		label_data='deadwood',
		label_quality=1,
		properties={'source': 'test_data'},
		aoi_gdf=None,
		aoi_image_quality=None,
		aoi_notes=None,
	)

	assert label.dataset_id == test_dataset_for_upload
	assert label.label_source == LabelSourceEnum.visual_interpretation
	assert label.label_type == LabelTypeEnum.segmentation
	assert label.label_data == LabelDataEnum.deadwood
	assert label.label_quality == 1
	assert label.aoi_id is None


def test_upload_label_with_polygon_holes(data_commands, test_dataset_for_upload):
	"""Test that polygons with holes are correctly processed in GeoJSON conversion"""
	# Create a polygon with a hole
	exterior = [(0, 0), (0, 10), (10, 10), (10, 0), (0, 0)]
	interior = [(2, 2), (2, 8), (8, 8), (8, 2), (2, 2)]
	poly_with_hole = Polygon(exterior, [interior])

	# Create another polygon with multiple holes
	exterior2 = [(20, 20), (20, 40), (40, 40), (40, 20), (20, 20)]
	interior2_1 = [(25, 25), (25, 30), (30, 30), (30, 25), (25, 25)]
	interior2_2 = [(32, 32), (32, 37), (37, 37), (37, 32), (32, 32)]
	poly_with_multiple_holes = Polygon(exterior2, [interior2_1, interior2_2])

	# Create a GeoDataFrame with these polygons
	labels_gdf = gpd.GeoDataFrame(geometry=[poly_with_hole, poly_with_multiple_holes])

	# Upload label using the existing test infrastructure
	label = data_commands.upload_label(
		dataset_id=test_dataset_for_upload,
		labels_gdf=labels_gdf,
		label_source='visual_interpretation',
		label_type='segmentation',
		label_data='deadwood',
		label_quality=1,
	)

	# Verify label was created correctly
	assert label.dataset_id == test_dataset_for_upload
	assert label.label_source == LabelSourceEnum.visual_interpretation
	assert label.label_type == LabelTypeEnum.segmentation
	assert label.label_data == LabelDataEnum.deadwood
	assert label.label_quality == 1

	# Get the geometries from the deadwood_geometries table and verify they have holes
	token = data_commands._ensure_auth()
	with use_client(token) as client:
		# Fetch geometries for this label from the deadwood_geometries table
		geom_response = client.table(settings.deadwood_geometries_table).select('*').eq('label_id', label.id).execute()

		# Verify we got geometries back
		assert len(geom_response.data) > 0

		# Convert the returned geometries to Shapely objects
		from shapely.geometry import shape

		geometries = [shape(geom_record['geometry']) for geom_record in geom_response.data]

		# Verify we have the expected number of polygons
		assert len(geometries) == 2

		# Check that each polygon has the correct number of interior rings (holes)
		# The first polygon should have 1 interior ring
		assert len(list(geometries[0].interiors)) == 1

		# The second polygon should have 2 interior rings
		assert len(list(geometries[1].interiors)) == 2

		# Verify the coordinates of the first polygon's hole
		first_hole_coords = list(geometries[0].interiors)[0].coords
		# Convert to list of tuples for easier comparison
		first_hole_points = [(round(x, 1), round(y, 1)) for x, y in first_hole_coords]
		# The first hole should contain these points (approximately)
		assert (2.0, 2.0) in first_hole_points
		assert (8.0, 8.0) in first_hole_points

		# Verify the coordinates of the second polygon's holes
		second_holes = list(geometries[1].interiors)
		second_hole_points = [[(round(x, 1), round(y, 1)) for x, y in hole.coords] for hole in second_holes]

		# Find which hole is which (they could be in any order)
		first_interior_hole = next(
			hole for hole in second_hole_points if any(p[0] == 25.0 and p[1] == 25.0 for p in hole)
		)
		second_interior_hole = next(
			hole for hole in second_hole_points if any(p[0] == 32.0 and p[1] == 32.0 for p in hole)
		)

		# Verify hole coordinates
		assert (25.0, 25.0) in first_interior_hole
		assert (30.0, 30.0) in first_interior_hole
		assert (32.0, 32.0) in second_interior_hole
		assert (37.0, 37.0) in second_interior_hole
