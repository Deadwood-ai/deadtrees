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
from shapely.geometry import Polygon
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
			'ortho_processed': True,
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
			start_processing=False,
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
			start_processing=False,
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
