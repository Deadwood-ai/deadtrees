import pytest
from pathlib import Path
import zipfile
from shapely import MultiPolygon
from shapely.geometry import Polygon
import shutil
import tempfile
import geopandas as gpd
import pyogrio

from shared.db import use_client
from shared.settings import settings
from fastapi.testclient import TestClient
from api.src.server import app
from shared.models import (
	StatusEnum,
	LicenseEnum,
	PlatformEnum,
	DatasetAccessEnum,
	LabelPayloadData,
	LabelSourceEnum,
	LabelTypeEnum,
	LabelDataEnum,
)
from api.src.download.cleanup import cleanup_downloads_directory
from shared.labels import create_label_with_geometries
from shared.testing.fixtures import login

client = TestClient(app)


@pytest.fixture(scope='function')
def test_dataset_for_download(auth_token, data_directory, test_file, test_user):
	"""Create a temporary test dataset for download testing"""
	with use_client(auth_token) as client:
		# Copy test file to archive directory
		file_name = 'test-download.tif'
		archive_path = data_directory / settings.archive_path / file_name
		shutil.copy2(test_file, archive_path)

		# Create test dataset with combined metadata fields
		dataset_data = {
			'file_name': file_name,
			'user_id': test_user,
			'license': LicenseEnum.cc_by.value,
			'platform': PlatformEnum.drone.value,
			'authors': ['Test Author'],
			'aquisition_year': 2024,
			'aquisition_month': 1,
			'aquisition_day': 1,
			'data_access': DatasetAccessEnum.public.value,
			'additional_information': 'Test dataset',
		}
		response = client.table(settings.datasets_table).insert(dataset_data).execute()
		dataset_id = response.data[0]['id']

		# Create ortho entry
		ortho_data = {
			'dataset_id': dataset_id,
			'ortho_file_name': file_name,
			'version': 1,
			'ortho_file_size': max(1, int((archive_path.stat().st_size / 1024 / 1024))),  # in MB
			'ortho_upload_runtime': 0.1,
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
			# Cleanup file
			if archive_path.exists():
				archive_path.unlink()


def test_download_dataset(auth_token, test_dataset_for_download):
	"""Test downloading a complete dataset ZIP bundle"""
	# Make request to download endpoint using TestClient
	response = client.get(
		f'/api/v1/download/datasets/{test_dataset_for_download}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
		follow_redirects=False,  # Don't follow redirects to check the nginx URL
	)

	# Check redirect response
	assert response.status_code == 303
	assert response.headers['location'] == f'/downloads/v1/{test_dataset_for_download}/{test_dataset_for_download}.zip'

	# Verify the file exists in downloads directory
	download_file = settings.downloads_path / str(test_dataset_for_download) / f'{test_dataset_for_download}.zip'
	assert download_file.exists()

	# Verify ZIP contents
	with zipfile.ZipFile(download_file) as zf:
		files = zf.namelist()

		# Verify expected files
		assert any(f.startswith('ortho_') and f.endswith('.tif') for f in files)
		assert 'METADATA.csv' in files
		assert 'CITATION.cff' in files
		assert 'LICENSE.txt' in files


def test_download_cleanup(auth_token, test_dataset_for_download):
	"""Test that downloaded files are cleaned up properly"""
	# Make initial download request
	response = client.get(
		f'/api/v1/download/datasets/{test_dataset_for_download}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
		follow_redirects=False,
	)

	download_file = settings.downloads_path / str(test_dataset_for_download) / f'{test_dataset_for_download}.zip'
	assert download_file.exists()

	# Run cleanup directly
	cleanup_downloads_directory(max_age_hours=0)

	# Verify cleanup
	assert not download_file.exists()
	assert not download_file.parent.exists()


@pytest.fixture(scope='function')
def test_dataset_with_label(auth_token, test_dataset_for_download, test_user):
	"""Create a test dataset with label from real GeoPackage data"""
	# Load geometries from test GeoPackage
	test_file = Path(__file__).parent.parent.parent.parent / 'assets' / 'test_data' / 'yanspain_crop_124_polygons.gpkg'

	# Read both layers
	deadwood = gpd.read_file(test_file, layer='standing_deadwood').to_crs(epsg=4326)
	aoi = gpd.read_file(test_file, layer='aoi').to_crs(epsg=4326)

	# Convert deadwood geometries to MultiPolygon GeoJSON
	deadwood_geojson = {
		'type': 'MultiPolygon',
		'coordinates': [
			[
				[[float(x), float(y)] for x, y in poly.exterior.coords]
				for geom in deadwood.geometry
				for poly in (geom if isinstance(geom, MultiPolygon) else [geom])
			]
		],
	}

	# Convert AOI to MultiPolygon GeoJSON
	aoi_geojson = {
		'type': 'MultiPolygon',
		'coordinates': [
			[
				[[float(x), float(y)] for x, y in poly.exterior.coords]
				for geom in aoi.geometry
				for poly in (geom if isinstance(geom, MultiPolygon) else [geom])
			]
		],
	}

	# Create label payload
	payload = LabelPayloadData(
		dataset_id=test_dataset_for_download,
		label_source=LabelSourceEnum.visual_interpretation,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.deadwood,
		label_quality=1,
		geometry=deadwood_geojson,
		properties={'source': 'test_data'},
		# AOI fields
		aoi_geometry=aoi_geojson,
		aoi_image_quality=1,
		aoi_notes='Test AOI from real data',
	)

	# Create label using the create_label_with_geometries function
	label = create_label_with_geometries(payload, test_user, auth_token)

	yield test_dataset_for_download

	# Cleanup labels and geometries
	with use_client(auth_token) as client:
		# Get all labels for the dataset
		response = (
			client.table(settings.labels_table).select('id').eq('dataset_id', test_dataset_for_download).execute()
		)

		# Delete all associated geometries and labels
		for label_record in response.data:
			client.table(settings.deadwood_geometries_table).delete().eq('label_id', label_record['id']).execute()
			client.table(settings.aois_table).delete().eq('id', label.aoi_id).execute()

		client.table(settings.labels_table).delete().eq('dataset_id', test_dataset_for_download).execute()


def test_download_dataset_with_labels(auth_token, test_dataset_with_label):
	"""Test downloading a dataset that includes labels"""
	dataset_id = test_dataset_with_label  # await the fixture

	response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
		follow_redirects=False,
	)

	# Check redirect response
	assert response.status_code == 303
	assert response.headers['location'] == f'/downloads/v1/{dataset_id}/{dataset_id}.zip'

	# Verify the file exists in downloads directory
	download_file = settings.downloads_path / str(dataset_id) / f'{dataset_id}.zip'
	assert download_file.exists()

	# Verify ZIP contents
	with zipfile.ZipFile(download_file) as zf:
		files = zf.namelist()

		# Check for expected files
		assert any(f.startswith('ortho_') and f.endswith('.tif') for f in files)
		assert any(f.startswith('labels_') and f.endswith('.gpkg') for f in files)
		assert 'METADATA.csv' in files
		assert 'CITATION.cff' in files
		assert 'LICENSE.txt' in files

		# Extract and verify the GeoPackage
		labels_file = next(f for f in files if f.endswith('.gpkg'))
		with tempfile.TemporaryDirectory() as tmpdir:
			zf.extract(labels_file, tmpdir)
			gpkg_path = Path(tmpdir) / labels_file

			# Verify layers in GeoPackage
			gdf_labels = gpd.read_file(gpkg_path, layer='labels')
			gdf_aoi = gpd.read_file(gpkg_path, layer='aoi')

			assert len(gdf_labels) > 0  # Should have deadwood polygons
			assert len(gdf_aoi) == 1  # Should have one AOI polygon

			# Verify properties
			assert gdf_labels.iloc[0]['source'] == 'test_data'
			assert gdf_aoi.iloc[0]['image_quality'] == 1
			assert gdf_aoi.iloc[0]['notes'] == 'Test AOI from real data'


@pytest.fixture(scope='function')
def test_dataset_with_label_no_aoi(auth_token, test_dataset_for_download, test_user):
	"""Create a test dataset with label but without AOI"""
	# Load geometries from test GeoPackage
	test_file = Path(__file__).parent.parent.parent.parent / 'assets' / 'test_data' / 'yanspain_crop_124_polygons.gpkg'

	# Read deadwood layer only
	deadwood = gpd.read_file(test_file, layer='standing_deadwood').to_crs(epsg=4326)

	# Convert deadwood geometries to MultiPolygon GeoJSON
	deadwood_geojson = {
		'type': 'MultiPolygon',
		'coordinates': [
			[
				[[float(x), float(y)] for x, y in poly.exterior.coords]
				for geom in deadwood.geometry
				for poly in (geom if isinstance(geom, MultiPolygon) else [geom])
			]
		],
	}

	# Create label payload without AOI
	payload = LabelPayloadData(
		dataset_id=test_dataset_for_download,
		label_source=LabelSourceEnum.visual_interpretation,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.deadwood,
		label_quality=1,
		geometry=deadwood_geojson,
		# properties={'source': 'test_data'}, # fix error based by having properties null
	)

	# Create label using the create_label_with_geometries function
	label = create_label_with_geometries(payload, test_user, auth_token)

	yield test_dataset_for_download

	# Cleanup labels and geometries
	with use_client(auth_token) as client:
		# Get all labels for the dataset
		response = (
			client.table(settings.labels_table).select('id').eq('dataset_id', test_dataset_for_download).execute()
		)

		# Delete all associated geometries and labels
		for label_record in response.data:
			client.table(settings.deadwood_geometries_table).delete().eq('label_id', label_record['id']).execute()

		client.table(settings.labels_table).delete().eq('dataset_id', test_dataset_for_download).execute()


def test_download_dataset_with_labels_no_aoi(auth_token, test_dataset_with_label_no_aoi):
	"""Test downloading a dataset that includes labels but no AOI"""
	dataset_id = test_dataset_with_label_no_aoi

	response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
		follow_redirects=False,
	)

	# Check redirect response
	assert response.status_code == 303
	assert response.headers['location'] == f'/downloads/v1/{dataset_id}/{dataset_id}.zip'

	# Verify the file exists in downloads directory
	download_file = settings.downloads_path / str(dataset_id) / f'{dataset_id}.zip'
	assert download_file.exists()

	# Verify ZIP contents
	with zipfile.ZipFile(download_file) as zf:
		files = zf.namelist()

		# Check for expected files
		assert any(f.startswith('ortho_') and f.endswith('.tif') for f in files)
		assert any(f.startswith('labels_') and f.endswith('.gpkg') for f in files)
		assert 'METADATA.csv' in files
		assert 'CITATION.cff' in files
		assert 'LICENSE.txt' in files

		# Extract and verify the GeoPackage
		labels_file = next(f for f in files if f.endswith('.gpkg'))
		with tempfile.TemporaryDirectory() as tmpdir:
			zf.extract(labels_file, tmpdir)
			gpkg_path = Path(tmpdir) / labels_file

			# Verify labels layer exists and has content
			gdf_labels = gpd.read_file(gpkg_path, layer='labels')
			assert len(gdf_labels) > 0  # Should have deadwood polygons
			assert gdf_labels.iloc[0]['source'] == 'visual_interpretation'

			# Verify AOI layer doesn't exist
			with pytest.raises(pyogrio.errors.DataLayerError, match="Layer 'aoi' could not be opened"):
				gpd.read_file(gpkg_path, layer='aoi')


# def test_download_dataset_with_null_aoi(auth_token, test_dataset_for_download, test_user):
# 	"""Test downloading a dataset with a label that has NULL aoi_id"""
# 	# Get processor credentials
# 	processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

# 	# Create label with NULL aoi_id using processor credentials
# 	with use_client(processor_token) as db_client:  # renamed to db_client for clarity
# 		label_data = {
# 			'dataset_id': test_dataset_for_download,
# 			'aoi_id': None,  # Explicitly NULL
# 			'label_source': 'model_prediction',
# 			'label_type': 'semantic_segmentation',
# 			'label_data': 'deadwood',
# 			'label_quality': 3,
# 			'user_id': test_user,  # Important: set the user_id to maintain ownership
# 		}
# 		response = db_client.table(settings.labels_table).insert(label_data).execute()
# 		assert response.data, 'Failed to create test label'

# 	with use_client(auth_token) as db_client:
# 		# Use TestClient for HTTP requests
# 		response = client.get(  # This is the global TestClient from the test file
# 			f'/api/v1/download/datasets/{test_dataset_for_download}/dataset.zip',
# 			headers={'Authorization': f'Bearer {auth_token}'},
# 			follow_redirects=False,
# 		)

# 	# Check redirect response
# 	assert response.status_code == 303
# 	assert response.headers['location'] == f'/downloads/v1/{test_dataset_for_download}/{test_dataset_for_download}.zip'

# 	# Verify the file exists in downloads directory
# 	download_file = settings.downloads_path / str(test_dataset_for_download) / f'{test_dataset_for_download}.zip'
# 	assert download_file.exists()


# def test_download_dataset_with_no_aoi(test_dataset_with_label_no_aoi, auth_token):
# 	"""Test downloading a dataset that has labels but no AOI"""
# 	dataset_id = test_dataset_with_label_no_aoi

# 	response = client.get(
# 		f'/api/v1/download/datasets/{dataset_id}/dataset.zip',
# 		headers={'Authorization': f'Bearer {auth_token}'},
# 		follow_redirects=False,
# 	)

# 	assert response.status_code == 303
# 	assert response.headers['location'] == f'/downloads/v1/{dataset_id}/{dataset_id}.zip'

# 	# Verify the file exists in downloads directory
# 	download_file = settings.downloads_path / str(dataset_id) / f'{dataset_id}.zip'
# 	assert download_file.exists()


def test_download_labels_with_aoi(auth_token, test_dataset_with_label):
	"""Test downloading just the labels with AOI for a dataset"""
	dataset_id = test_dataset_with_label

	response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/labels.gpkg',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Check response
	assert response.status_code == 200
	assert response.headers['content-type'] == 'application/zip'
	assert response.headers['content-disposition'] == f'attachment; filename="labels_{dataset_id}.zip"'

	# Save response content to temporary file and verify
	with tempfile.TemporaryDirectory() as tmpdir:
		zip_path = Path(tmpdir) / f'labels_{dataset_id}.zip'
		zip_path.write_bytes(response.content)

		with zipfile.ZipFile(zip_path) as zf:
			# Check for expected files
			files = zf.namelist()
			assert f'labels_{dataset_id}.gpkg' in files
			assert 'CITATION.cff' in files

			# Extract and verify the GeoPackage
			gpkg_path = Path(tmpdir) / f'labels_{dataset_id}.gpkg'
			zf.extract(f'labels_{dataset_id}.gpkg', tmpdir)

			# Verify layers in GeoPackage
			gdf_labels = gpd.read_file(gpkg_path, layer='labels')
			gdf_aoi = gpd.read_file(gpkg_path, layer='aoi')

			assert len(gdf_labels) > 0  # Should have deadwood polygons
			assert len(gdf_aoi) == 1  # Should have one AOI polygon

			# Verify properties
			assert gdf_labels.iloc[0]['source'] == 'test_data'
			assert gdf_aoi.iloc[0]['image_quality'] == 1
			assert gdf_aoi.iloc[0]['notes'] == 'Test AOI from real data'

			# Verify citation file
			citation_content = zf.read('CITATION.cff').decode('utf-8')
			assert 'cff-version: 1.2.0' in citation_content
			assert 'deadtrees.earth' in citation_content


def test_download_labels_without_aoi(auth_token, test_dataset_with_label_no_aoi):
	"""Test downloading just the labels without AOI for a dataset"""
	dataset_id = test_dataset_with_label_no_aoi

	response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/labels.gpkg',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Check response
	assert response.status_code == 200
	assert response.headers['content-type'] == 'application/zip'
	assert response.headers['content-disposition'] == f'attachment; filename="labels_{dataset_id}.zip"'

	# Save response content to temporary file and verify
	with tempfile.TemporaryDirectory() as tmpdir:
		zip_path = Path(tmpdir) / f'labels_{dataset_id}.zip'
		zip_path.write_bytes(response.content)

		with zipfile.ZipFile(zip_path) as zf:
			# Check for expected files
			files = zf.namelist()
			assert f'labels_{dataset_id}.gpkg' in files
			assert 'CITATION.cff' in files

			# Extract and verify the GeoPackage
			gpkg_path = Path(tmpdir) / f'labels_{dataset_id}.gpkg'
			zf.extract(f'labels_{dataset_id}.gpkg', tmpdir)

			# Verify labels layer exists and has content
			gdf_labels = gpd.read_file(gpkg_path, layer='labels')
			assert len(gdf_labels) > 0  # Should have deadwood polygons
			assert gdf_labels.iloc[0]['source'] == 'visual_interpretation'

			# Verify AOI layer doesn't exist
			with pytest.raises(pyogrio.errors.DataLayerError, match="Layer 'aoi' could not be opened"):
				gpd.read_file(gpkg_path, layer='aoi')

			# Verify citation file
			citation_content = zf.read('CITATION.cff').decode('utf-8')
			assert 'cff-version: 1.2.0' in citation_content
			assert 'deadtrees.earth' in citation_content


def test_download_labels_not_found(auth_token, test_dataset_for_download):
	"""Test attempting to download labels for a dataset that has none"""
	response = client.get(
		f'/api/v1/download/datasets/{test_dataset_for_download}/labels.gpkg',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	assert response.status_code == 404
	assert 'has no labels' in response.json()['detail']
