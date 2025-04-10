import pytest
from pathlib import Path
import zipfile
from shapely import MultiPolygon
from shapely.geometry import Polygon
import shutil
import tempfile
import geopandas as gpd
import pyogrio
import time
import fiona
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
	"""Test downloading a complete dataset ZIP bundle (now using the async approach)"""
	# Make initial request to start the download
	response = client.get(
		f'/api/v1/download/datasets/{test_dataset_for_download}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Check response format and properties
	assert response.status_code == 200
	data = response.json()
	assert 'status' in data
	assert 'job_id' in data
	assert data['job_id'] == str(test_dataset_for_download)

	# Wait a bit for processing to complete
	max_attempts = 5
	for _ in range(max_attempts):
		# Check status
		status_response = client.get(
			f'/api/v1/download/datasets/{test_dataset_for_download}/status',
			headers={'Authorization': f'Bearer {auth_token}'},
		)
		assert status_response.status_code == 200
		status_data = status_response.json()

		if status_data['status'] == 'completed':
			download_path = status_data['download_path']
			break

		# Wait before checking again
		time.sleep(1)
	else:
		pytest.fail('Dataset processing did not complete within expected time')

	# Test the download redirect endpoint
	download_response = client.get(
		f'/api/v1/download/datasets/{test_dataset_for_download}/download',
		headers={'Authorization': f'Bearer {auth_token}'},
		follow_redirects=False,
	)
	assert download_response.status_code == 303
	assert (
		download_response.headers['location']
		== f'/downloads/v1/{test_dataset_for_download}/{test_dataset_for_download}.zip'
	)

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
	# Make initial download request and wait for completion
	response = client.get(
		f'/api/v1/download/datasets/{test_dataset_for_download}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Wait for processing to complete
	max_attempts = 5
	for _ in range(max_attempts):
		status_response = client.get(
			f'/api/v1/download/datasets/{test_dataset_for_download}/status',
			headers={'Authorization': f'Bearer {auth_token}'},
		)
		if status_response.json()['status'] == 'completed':
			break
		time.sleep(1)

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
	dataset_id = test_dataset_with_label

	# Make initial request
	response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Check response format
	assert response.status_code == 200
	data = response.json()
	assert data['job_id'] == str(dataset_id)

	# Wait for processing to complete
	max_attempts = 5
	for _ in range(max_attempts):
		status_response = client.get(
			f'/api/v1/download/datasets/{dataset_id}/status',
			headers={'Authorization': f'Bearer {auth_token}'},
		)
		if status_response.json()['status'] == 'completed':
			break
		time.sleep(1)
	else:
		pytest.fail('Dataset processing did not complete within expected time')

	# Get the actual download
	download_response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/download',
		headers={'Authorization': f'Bearer {auth_token}'},
		follow_redirects=False,
	)
	assert download_response.status_code == 303

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
		labels_file = next(f for f in files if f.startswith('labels_') and f.endswith('.gpkg'))
		with tempfile.TemporaryDirectory() as tmpdir:
			zf.extract(labels_file, tmpdir)
			gpkg_path = Path(tmpdir) / labels_file

			# List all available layers in the GeoPackage
			available_layers = fiona.listlayers(gpkg_path)

			# Verify the deadwood layer exists (instead of 'labels')
			assert 'deadwood' in available_layers

			# Verify layers in GeoPackage - use 'deadwood' instead of 'labels'
			gdf_labels = gpd.read_file(gpkg_path, layer='deadwood')

			# Find AOI layer (should start with 'aoi_')
			aoi_layers = [layer for layer in available_layers if layer.startswith('aoi_')]
			assert len(aoi_layers) > 0
			gdf_aoi = gpd.read_file(gpkg_path, layer=aoi_layers[0])

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

	# Make initial request
	response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Check response format
	assert response.status_code == 200
	data = response.json()
	assert data['job_id'] == str(dataset_id)

	# Wait for processing to complete
	max_attempts = 5
	for _ in range(max_attempts):
		status_response = client.get(
			f'/api/v1/download/datasets/{dataset_id}/status',
			headers={'Authorization': f'Bearer {auth_token}'},
		)
		if status_response.json()['status'] == 'completed':
			break
		time.sleep(1)
	else:
		pytest.fail('Dataset processing did not complete within expected time')

	# Get the actual download
	download_response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/download',
		headers={'Authorization': f'Bearer {auth_token}'},
		follow_redirects=False,
	)
	assert download_response.status_code == 303

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
		labels_file = next(f for f in files if f.startswith('labels_') and f.endswith('.gpkg'))
		with tempfile.TemporaryDirectory() as tmpdir:
			zf.extract(labels_file, tmpdir)
			gpkg_path = Path(tmpdir) / labels_file

			# Verify labels layer exists and has content
			gdf_labels = gpd.read_file(gpkg_path, layer='deadwood')
			assert len(gdf_labels) > 0  # Should have deadwood polygons
			assert gdf_labels.iloc[0]['source'] == 'visual_interpretation'

			# Verify AOI layer doesn't exist
			with pytest.raises(pyogrio.errors.DataLayerError, match="Layer 'aoi' could not be opened"):
				gpd.read_file(gpkg_path, layer='aoi')


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
			# We now have the label type in the filename, so look for a file that contains the dataset_id
			assert any(f.startswith('labels_') and str(dataset_id) in f for f in files)
			assert 'CITATION.cff' in files

			# Extract and verify the GeoPackage
			label_file = next(f for f in files if f.startswith('labels_') and str(dataset_id) in f)
			gpkg_path = Path(tmpdir) / label_file
			zf.extract(label_file, tmpdir)

			# List all available layers in the GeoPackage
			available_layers = fiona.listlayers(gpkg_path)

			# Verify the deadwood layer exists (instead of 'labels')
			assert 'deadwood' in available_layers

			# Read the deadwood layer
			gdf_labels = gpd.read_file(gpkg_path, layer='deadwood')

			# Find AOI layer (should start with 'aoi_')
			aoi_layers = [layer for layer in available_layers if layer.startswith('aoi_')]
			assert len(aoi_layers) > 0
			gdf_aoi = gpd.read_file(gpkg_path, layer=aoi_layers[0])

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
			# We now have the label type in the filename, so look for a file that contains the dataset_id
			assert any(f.startswith('labels_') and str(dataset_id) in f for f in files)
			assert 'CITATION.cff' in files

			# Extract and verify the GeoPackage
			label_file = next(f for f in files if f.startswith('labels_') and str(dataset_id) in f)
			gpkg_path = Path(tmpdir) / label_file
			zf.extract(label_file, tmpdir)

			# List all available layers in the GeoPackage
			available_layers = fiona.listlayers(gpkg_path)

			# Verify the deadwood layer exists (instead of 'labels')
			assert 'deadwood' in available_layers

			# Read the deadwood layer
			gdf_labels = gpd.read_file(gpkg_path, layer='deadwood')
			assert len(gdf_labels) > 0  # Should have deadwood polygons
			assert gdf_labels.iloc[0]['source'] == 'visual_interpretation'

			# Verify no AOI layer exists
			assert not any(layer.startswith('aoi_') for layer in available_layers)

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


def test_download_dataset_async(auth_token, test_dataset_for_download):
	"""Test asynchronous downloading of a dataset bundle"""
	# Make initial request to start the download
	response = client.get(
		f'/api/v1/download/datasets/{test_dataset_for_download}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Check response format and properties
	assert response.status_code == 200
	data = response.json()
	assert 'status' in data
	assert 'job_id' in data
	assert data['job_id'] == str(test_dataset_for_download)

	# Status should be either PROCESSING or COMPLETED
	assert data['status'] in ['processing', 'completed']

	# Wait a bit for processing to complete (if needed)
	max_attempts = 5
	for _ in range(max_attempts):
		# Check status
		status_response = client.get(
			f'/api/v1/download/datasets/{test_dataset_for_download}/status',
			headers={'Authorization': f'Bearer {auth_token}'},
		)
		assert status_response.status_code == 200
		status_data = status_response.json()

		if status_data['status'] == 'completed':
			# Verify download path is present
			assert 'download_path' in status_data
			assert (
				status_data['download_path']
				== f'/downloads/v1/{test_dataset_for_download}/{test_dataset_for_download}.zip'
			)
			break

		# Wait before checking again
		time.sleep(1)
	else:
		pytest.fail('Dataset processing did not complete within expected time')

	# Verify the file exists in downloads directory
	download_file = settings.downloads_path / str(test_dataset_for_download) / f'{test_dataset_for_download}.zip'
	assert download_file.exists()

	# Test the download redirect endpoint
	download_response = client.get(
		f'/api/v1/download/datasets/{test_dataset_for_download}/download',
		headers={'Authorization': f'Bearer {auth_token}'},
		follow_redirects=False,
	)
	assert download_response.status_code == 303
	assert (
		download_response.headers['location']
		== f'/downloads/v1/{test_dataset_for_download}/{test_dataset_for_download}.zip'
	)

	# Verify ZIP contents
	with zipfile.ZipFile(download_file) as zf:
		files = zf.namelist()
		# Verify expected files
		assert any(f.startswith('ortho_') and f.endswith('.tif') for f in files)
		assert 'METADATA.csv' in files
		assert 'CITATION.cff' in files
		assert 'LICENSE.txt' in files


def test_download_dataset_already_exists(auth_token, test_dataset_for_download):
	"""Test requesting a download when the file already exists"""
	# First ensure the download exists
	response = client.get(
		f'/api/v1/download/datasets/{test_dataset_for_download}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Wait until processing completes
	max_attempts = 5
	for _ in range(max_attempts):
		status_response = client.get(
			f'/api/v1/download/datasets/{test_dataset_for_download}/status',
			headers={'Authorization': f'Bearer {auth_token}'},
		)
		if status_response.json()['status'] == 'completed':
			break
		time.sleep(1)

	# Now request the download again
	second_response = client.get(
		f'/api/v1/download/datasets/{test_dataset_for_download}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Should immediately return COMPLETED status
	assert second_response.status_code == 200
	data = second_response.json()
	assert data['status'] == 'completed'
	assert 'download_path' in data
	assert data['job_id'] == str(test_dataset_for_download)


def test_download_dataset_with_multiple_labels(auth_token, test_dataset_for_download, test_user):
	"""Test downloading a dataset with multiple label types"""
	dataset_id = test_dataset_for_download

	# Create two different types of labels for the same dataset
	# First create a deadwood label
	test_file = Path(__file__).parent.parent.parent.parent / 'assets' / 'test_data' / 'yanspain_crop_124_polygons.gpkg'
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

	# Create deadwood label payload
	deadwood_payload = LabelPayloadData(
		dataset_id=dataset_id,
		label_source=LabelSourceEnum.visual_interpretation,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.deadwood,
		label_quality=1,
		geometry=deadwood_geojson,
	)

	# Create deadwood label payload
	deadwood_payload_2 = LabelPayloadData(
		dataset_id=dataset_id,
		label_source=LabelSourceEnum.model_prediction,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.deadwood,
		label_quality=2,
		geometry=deadwood_geojson,
	)

	# Create forest cover label payload (using the same geometry for testing simplicity)
	forest_cover_payload = LabelPayloadData(
		dataset_id=dataset_id,
		label_source=LabelSourceEnum.model_prediction,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.forest_cover,
		label_quality=2,
		geometry=deadwood_geojson,
	)

	# Create both labels
	deadwood_label = create_label_with_geometries(deadwood_payload, test_user, auth_token)
	deadwood_label_2 = create_label_with_geometries(deadwood_payload_2, test_user, auth_token)
	forest_cover_label = create_label_with_geometries(forest_cover_payload, test_user, auth_token)

	# Make initial request to start the download
	response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Wait for processing to complete
	max_attempts = 5
	for _ in range(max_attempts):
		status_response = client.get(
			f'/api/v1/download/datasets/{dataset_id}/status',
			headers={'Authorization': f'Bearer {auth_token}'},
		)
		if status_response.json()['status'] == 'completed':
			break
		time.sleep(1)

	# Get the download
	download_response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/download',
		headers={'Authorization': f'Bearer {auth_token}'},
		follow_redirects=False,
	)
	assert download_response.status_code == 303

	# Verify the file exists
	download_file = settings.downloads_path / str(dataset_id) / f'{dataset_id}.zip'
	assert download_file.exists()

	# Verify ZIP contents includes both label types
	with zipfile.ZipFile(download_file) as zf:
		files = zf.namelist()

		# Check for label files for both types
		assert any(f'labels_{LabelDataEnum.deadwood.value}_{dataset_id}.gpkg' in f for f in files)
		assert any(f'labels_{LabelDataEnum.forest_cover.value}_{dataset_id}.gpkg' in f for f in files)

		# Verify each label file
		deadwood_file = next(f for f in files if f'labels_{LabelDataEnum.deadwood.value}_{dataset_id}.gpkg' in f)
		forest_cover_file = next(
			f for f in files if f'labels_{LabelDataEnum.forest_cover.value}_{dataset_id}.gpkg' in f
		)

		with tempfile.TemporaryDirectory() as tmpdir:
			# Extract and check deadwood labels
			zf.extract(deadwood_file, tmpdir)
			deadwood_path = Path(tmpdir) / deadwood_file

			# Verify deadwood layer
			gdf_deadwood = gpd.read_file(deadwood_path, layer=LabelDataEnum.deadwood)
			assert len(gdf_deadwood) > 0
			assert gdf_deadwood.iloc[0]['source'] == 'visual_interpretation'
			assert gdf_deadwood.iloc[0]['quality'] == 1

			# Extract and check forest cover labels
			zf.extract(forest_cover_file, tmpdir)
			forest_cover_path = Path(tmpdir) / forest_cover_file

			# Verify forest cover layer
			gdf_forest = gpd.read_file(forest_cover_path, layer=LabelDataEnum.forest_cover)
			assert len(gdf_forest) > 0
			assert gdf_forest.iloc[0]['source'] == 'model_prediction'
			assert gdf_forest.iloc[0]['quality'] == 2


def test_download_multiple_label_types(auth_token, test_dataset_for_download, test_user):
	"""Test downloading just the labels when multiple label types exist"""
	dataset_id = test_dataset_for_download

	# Create different types of labels for the same dataset
	test_file = Path(__file__).parent.parent.parent.parent / 'assets' / 'test_data' / 'yanspain_crop_124_polygons.gpkg'
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

	# Create deadwood label with visual interpretation
	deadwood_payload_visual = LabelPayloadData(
		dataset_id=dataset_id,
		label_source=LabelSourceEnum.visual_interpretation,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.deadwood,
		label_quality=1,
		geometry=deadwood_geojson,
	)

	# Create deadwood label with model prediction
	deadwood_payload_model = LabelPayloadData(
		dataset_id=dataset_id,
		label_source=LabelSourceEnum.model_prediction,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.deadwood,
		label_quality=2,
		geometry=deadwood_geojson,
	)

	# Create forest cover label
	forest_cover_payload = LabelPayloadData(
		dataset_id=dataset_id,
		label_source=LabelSourceEnum.model_prediction,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.forest_cover,
		label_quality=2,
		geometry=deadwood_geojson,
	)

	# Create all labels
	deadwood_label_visual = create_label_with_geometries(deadwood_payload_visual, test_user, auth_token)
	deadwood_label_model = create_label_with_geometries(deadwood_payload_model, test_user, auth_token)
	forest_cover_label = create_label_with_geometries(forest_cover_payload, test_user, auth_token)

	client = use_client(auth_token)
	# Request labels download
	response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/labels.gpkg',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Check response
	assert response.status_code == 200
	assert response.headers['content-type'] == 'application/zip'

	# Save and verify contents
	with tempfile.TemporaryDirectory() as tmpdir:
		zip_path = Path(tmpdir) / f'labels_{dataset_id}.zip'
		zip_path.write_bytes(response.content)

		with zipfile.ZipFile(zip_path) as zf:
			files = zf.namelist()

			# Check for both label files
			deadwood_file = next(f for f in files if f'labels_{LabelDataEnum.deadwood}_{dataset_id}.gpkg' in f)
			forest_cover_file = next(f for f in files if f'labels_{LabelDataEnum.forest_cover}_{dataset_id}.gpkg' in f)

			# Extract and check deadwood labels file
			zf.extract(deadwood_file, tmpdir)
			gpkg_path = Path(tmpdir) / deadwood_file

			# Get all layers in the deadwood file - should have both visual and model layers
			deadwood_layers = gpd.io.list_layers(gpkg_path)

			# Verify we have two deadwood layers (one for each source)
			deadwood_label_layers = [layer for layer in deadwood_layers if layer.startswith('deadwood_')]
			assert len(deadwood_label_layers) == 2

			# Check the layer containing visual interpretation
			visual_layer = next(
				layer
				for layer in deadwood_label_layers
				if gpd.read_file(gpkg_path, layer=layer).iloc[0]['source'] == 'visual_interpretation'
			)
			gdf_visual = gpd.read_file(gpkg_path, layer=visual_layer)
			assert len(gdf_visual) > 0
			assert gdf_visual.iloc[0]['quality'] == 1

			# Check the layer containing model prediction
			model_layer = next(
				layer
				for layer in deadwood_label_layers
				if gpd.read_file(gpkg_path, layer=layer).iloc[0]['source'] == 'model_prediction'
			)
			gdf_model = gpd.read_file(gpkg_path, layer=model_layer)
			assert len(gdf_model) > 0
			assert gdf_model.iloc[0]['quality'] == 2

			# Extract and check forest cover file
			zf.extract(forest_cover_file, tmpdir)
			forest_path = Path(tmpdir) / forest_cover_file
			forest_layers = gpd.io.list_layers(forest_path)
			forest_label_layers = [layer for layer in forest_layers if layer.startswith('forest_cover_')]
			assert len(forest_label_layers) == 1

			# Check the forest cover layer
			gdf_forest = gpd.read_file(forest_path, layer=forest_label_layers[0])
			assert len(gdf_forest) > 0
			assert gdf_forest.iloc[0]['source'] == 'model_prediction'

	# Clean up created labels
	with use_client(auth_token) as client:
		for label in [deadwood_label_visual, deadwood_label_model, forest_cover_label]:
			if label.label_data == LabelDataEnum.deadwood:
				client.table(settings.deadwood_geometries_table).delete().eq('label_id', label.id).execute()
			else:
				client.table(settings.forest_cover_geometries_table).delete().eq('label_id', label.id).execute()
			client.table(settings.labels_table).delete().eq('id', label.id).execute()
