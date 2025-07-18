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
import json

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

			# Verify the deadwood layer exists (with source info in name)
			deadwood_layer = f'deadwood_{LabelSourceEnum.visual_interpretation.value}'
			assert deadwood_layer in available_layers

			# Verify layers in GeoPackage
			gdf_labels = gpd.read_file(gpkg_path, layer=deadwood_layer)

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
			deadwood_layer = f'deadwood_{LabelSourceEnum.visual_interpretation.value}'

			# List all available layers to debug
			available_layers = fiona.listlayers(gpkg_path)

			# Verify deadwood layer exists
			assert deadwood_layer in available_layers

			# Read the layer with correct naming
			gdf_labels = gpd.read_file(gpkg_path, layer=deadwood_layer)
			assert len(gdf_labels) > 0  # Should have deadwood polygons
			assert gdf_labels.iloc[0]['source'] == 'visual_interpretation'

			# Verify no AOI layer exists
			assert not any(layer.startswith('aoi_') for layer in available_layers)

			# Verify citation file
			citation_content = zf.read('CITATION.cff').decode('utf-8')
			assert 'cff-version: 1.2.0' in citation_content
			assert 'deadtrees.earth' in citation_content


def test_download_labels_with_aoi(auth_token, test_dataset_with_label):
	"""Test downloading consolidated labels and AOI as single GeoPackage"""
	dataset_id = test_dataset_with_label

	response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/labels.gpkg',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Check response
	assert response.status_code == 200
	assert response.headers['content-type'] == 'application/geopackage+sqlite3'
	assert response.headers['content-disposition'] == f'attachment; filename="dataset_{dataset_id}_labels.gpkg"'

	# Save and verify contents
	with tempfile.TemporaryDirectory() as tmpdir:
		gpkg_path = Path(tmpdir) / f'dataset_{dataset_id}_labels.gpkg'
		gpkg_path.write_bytes(response.content)

		# Get all layers in the consolidated geopackage
		layers = fiona.listlayers(gpkg_path)
		print(f'Layers in consolidated geopackage: {layers}')

		# Find deadwood layer (should be deadwood_visual_interpretation based on the test data)
		deadwood_layer = f'deadwood_{LabelSourceEnum.visual_interpretation.value}'
		assert deadwood_layer in layers, f'Deadwood layer {deadwood_layer} not found in: {layers}'

		# Read the deadwood layer
		gdf_visual = gpd.read_file(gpkg_path, layer=deadwood_layer)
		assert len(gdf_visual) > 0, 'Visual layer has no data'

		# Verify properties
		assert 'source' in gdf_visual.columns
		assert gdf_visual.iloc[0]['source'] in ['test_data', 'visual_interpretation']

		# Verify unified AOI layer exists
		assert 'aoi' in layers, f'AOI layer not found in: {layers}'

		# Check the AOI layer
		gdf_aoi = gpd.read_file(gpkg_path, layer='aoi')
		assert len(gdf_aoi) > 0, 'AOI layer has no data'
		assert gdf_aoi.iloc[0]['image_quality'] == 1
		assert gdf_aoi.iloc[0]['notes'] == 'Test AOI from real data'


def test_download_labels_without_aoi(auth_token, test_dataset_with_label_no_aoi):
	"""Test downloading consolidated labels without AOI as single GeoPackage"""
	dataset_id = test_dataset_with_label_no_aoi

	response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/labels.gpkg',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Check response
	assert response.status_code == 200
	assert response.headers['content-type'] == 'application/geopackage+sqlite3'
	assert response.headers['content-disposition'] == f'attachment; filename="dataset_{dataset_id}_labels.gpkg"'

	# Save response content to temporary file and verify
	with tempfile.TemporaryDirectory() as tmpdir:
		gpkg_path = Path(tmpdir) / f'dataset_{dataset_id}_labels.gpkg'
		gpkg_path.write_bytes(response.content)

		# List all available layers in the consolidated GeoPackage
		available_layers = fiona.listlayers(gpkg_path)
		print(f'Layers in consolidated geopackage: {available_layers}')

		# Verify the deadwood layer exists (with source info in name)
		deadwood_layer = f'deadwood_{LabelSourceEnum.visual_interpretation.value}'
		assert deadwood_layer in available_layers

		# Read the deadwood layer
		gdf_labels = gpd.read_file(gpkg_path, layer=deadwood_layer)
		assert len(gdf_labels) > 0  # Should have deadwood polygons
		assert gdf_labels.iloc[0]['source'] == 'visual_interpretation'

		# Verify no AOI layer exists (since this dataset has no AOI)
		assert 'aoi' not in available_layers


def test_download_consolidated_labels_multiple_types(auth_token, test_dataset_for_download, test_user):
	"""Test downloading consolidated labels with multiple label types and sources in single GeoPackage"""
	dataset_id = test_dataset_for_download

	# Create test geometries
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

	# Create multiple labels with different sources and data types
	# 1. Deadwood visual interpretation
	deadwood_visual_payload = LabelPayloadData(
		dataset_id=dataset_id,
		label_source=LabelSourceEnum.visual_interpretation,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.deadwood,
		label_quality=1,
		geometry=deadwood_geojson,
	)

	# 2. Deadwood model prediction
	deadwood_model_payload = LabelPayloadData(
		dataset_id=dataset_id,
		label_source=LabelSourceEnum.model_prediction,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.deadwood,
		label_quality=2,
		geometry=deadwood_geojson,
	)

	# 3. Forest cover model prediction
	forest_cover_model_payload = LabelPayloadData(
		dataset_id=dataset_id,
		label_source=LabelSourceEnum.model_prediction,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.forest_cover,
		label_quality=2,
		geometry=deadwood_geojson,
	)

	# 4. Fixed model prediction (should be filtered out)
	deadwood_fixed_payload = LabelPayloadData(
		dataset_id=dataset_id,
		label_source=LabelSourceEnum.fixed_model_prediction,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.deadwood,
		label_quality=3,
		geometry=deadwood_geojson,
	)

	# Create all labels
	deadwood_visual_label = create_label_with_geometries(deadwood_visual_payload, test_user, auth_token)
	deadwood_model_label = create_label_with_geometries(deadwood_model_payload, test_user, auth_token)
	forest_cover_model_label = create_label_with_geometries(forest_cover_model_payload, test_user, auth_token)
	deadwood_fixed_label = create_label_with_geometries(deadwood_fixed_payload, test_user, auth_token)

	# Download consolidated labels
	response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/labels.gpkg',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Check response
	assert response.status_code == 200
	assert response.headers['content-type'] == 'application/geopackage+sqlite3'
	assert response.headers['content-disposition'] == f'attachment; filename="dataset_{dataset_id}_labels.gpkg"'

	# Save and verify contents
	with tempfile.TemporaryDirectory() as tmpdir:
		gpkg_path = Path(tmpdir) / f'dataset_{dataset_id}_labels.gpkg'
		gpkg_path.write_bytes(response.content)

		# Get all layers in the consolidated geopackage
		layers = fiona.listlayers(gpkg_path)
		print(f'Layers in consolidated geopackage: {layers}')

		# Expected layers (filtered to exclude fixed_model_prediction)
		expected_layers = [
			'deadwood_visual_interpretation',
			'deadwood_model_prediction',
			'forest_cover_model_prediction',
		]

		# Verify expected layers exist
		for expected_layer in expected_layers:
			assert expected_layer in layers, f'Expected layer {expected_layer} not found in: {layers}'

		# Verify fixed_model_prediction layer is NOT included
		assert 'deadwood_fixed_model_prediction' not in layers, 'Fixed model prediction layer should be filtered out'

		# Verify each layer contains data and correct properties
		# Check deadwood visual interpretation
		gdf_deadwood_visual = gpd.read_file(gpkg_path, layer='deadwood_visual_interpretation')
		assert len(gdf_deadwood_visual) > 0
		assert gdf_deadwood_visual.iloc[0]['source'] == 'visual_interpretation'
		assert gdf_deadwood_visual.iloc[0]['quality'] == 1

		# Check deadwood model prediction
		gdf_deadwood_model = gpd.read_file(gpkg_path, layer='deadwood_model_prediction')
		assert len(gdf_deadwood_model) > 0
		assert gdf_deadwood_model.iloc[0]['source'] == 'model_prediction'
		assert gdf_deadwood_model.iloc[0]['quality'] == 2

		# Check forest cover model prediction
		gdf_forest_model = gpd.read_file(gpkg_path, layer='forest_cover_model_prediction')
		assert len(gdf_forest_model) > 0
		assert gdf_forest_model.iloc[0]['source'] == 'model_prediction'
		assert gdf_forest_model.iloc[0]['quality'] == 2


def test_download_labels_not_found(auth_token, test_dataset_for_download):
	"""Test attempting to download labels for a dataset that has none"""
	response = client.get(
		f'/api/v1/download/datasets/{test_dataset_for_download}/labels.gpkg',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	assert response.status_code == 404
	assert 'No labels found for dataset' in response.json()['detail']


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

			# List available layers in deadwood file
			deadwood_layers = fiona.listlayers(deadwood_path)

			# Get the visual interpretation layer
			visual_layer = f'{LabelDataEnum.deadwood.value}_{LabelSourceEnum.visual_interpretation.value}'
			assert visual_layer in deadwood_layers

			# Get the model prediction layer
			model_layer = f'{LabelDataEnum.deadwood.value}_{LabelSourceEnum.model_prediction.value}'
			assert model_layer in deadwood_layers

			# Verify deadwood visual interpretation layer
			gdf_visual = gpd.read_file(deadwood_path, layer=visual_layer)
			assert len(gdf_visual) > 0
			assert gdf_visual.iloc[0]['source'] == 'visual_interpretation'
			assert gdf_visual.iloc[0]['quality'] == 1

			# Verify deadwood model prediction layer
			gdf_model = gpd.read_file(deadwood_path, layer=model_layer)
			assert len(gdf_model) > 0
			assert gdf_model.iloc[0]['source'] == 'model_prediction'
			assert gdf_model.iloc[0]['quality'] == 2

			# Extract and check forest cover labels
			zf.extract(forest_cover_file, tmpdir)
			forest_cover_path = Path(tmpdir) / forest_cover_file

			# List available layers in forest cover file
			forest_layers = fiona.listlayers(forest_cover_path)

			# Get the forest cover layer (model prediction)
			forest_layer = f'{LabelDataEnum.forest_cover.value}_{LabelSourceEnum.model_prediction.value}'
			assert forest_layer in forest_layers

			# Verify forest cover layer
			gdf_forest = gpd.read_file(forest_cover_path, layer=forest_layer)
			assert len(gdf_forest) > 0
			assert gdf_forest.iloc[0]['source'] == 'model_prediction'
			assert gdf_forest.iloc[0]['quality'] == 2


def test_download_datasets_with_different_licenses(auth_token, data_directory, test_file, test_user):
	"""Test downloading datasets with different license types to ensure license info is correctly included"""
	created_datasets = []
	licenses_to_test = [
		(LicenseEnum.cc_by, 'Attribution 4.0 International'),
		(LicenseEnum.cc_by_sa, 'Attribution-ShareAlike 4.0 International'),
		(LicenseEnum.cc_by_nc, 'Attribution-NonCommercial 4.0 International'),
		(LicenseEnum.cc_by_nc_sa, 'Attribution-NonCommercial-ShareAlike 4.0 International'),
	]

	try:
		with use_client(auth_token) as supabase_client:
			# Create test datasets with different licenses
			for license_enum, expected_license_text in licenses_to_test:
				# Copy test file to archive directory
				file_name = f'test-download-{license_enum.value}.tif'
				archive_path = data_directory / settings.archive_path / file_name
				shutil.copy2(test_file, archive_path)

				# Create test dataset with specific license
				dataset_data = {
					'file_name': file_name,
					'user_id': test_user,
					'license': license_enum.value,
					'platform': PlatformEnum.drone.value,
					'authors': ['Test Author'],
					'aquisition_year': 2024,
					'aquisition_month': 1,
					'aquisition_day': 1,
					'data_access': DatasetAccessEnum.public.value,
					'additional_information': f'Test dataset with {license_enum.value} license',
				}
				response = supabase_client.table(settings.datasets_table).insert(dataset_data).execute()
				dataset_id = response.data[0]['id']
				created_datasets.append(dataset_id)

				# Create ortho entry
				ortho_data = {
					'dataset_id': dataset_id,
					'ortho_file_name': file_name,
					'version': 1,
					'ortho_file_size': max(1, int((archive_path.stat().st_size / 1024 / 1024))),  # in MB
					'ortho_upload_runtime': 0.1,
				}
				supabase_client.table(settings.orthos_table).insert(ortho_data).execute()

				# Create status entry
				status_data = {
					'dataset_id': dataset_id,
					'current_status': StatusEnum.idle.value,
					'is_upload_done': True,
					'is_ortho_done': True,
				}
				supabase_client.table(settings.statuses_table).insert(status_data).execute()

			# Test downloading each dataset and verify the license information
			for i, (license_enum, expected_license_text) in enumerate(licenses_to_test):
				dataset_id = created_datasets[i]

				# Make initial request to start the download using the TestClient
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
				else:
					pytest.fail('Dataset processing did not complete within expected time')

				# Verify the file exists in downloads directory
				download_file = settings.downloads_path / str(dataset_id) / f'{dataset_id}.zip'
				assert download_file.exists()

				# Extract and verify license information
				with zipfile.ZipFile(download_file) as zf:
					files = zf.namelist()
					assert 'LICENSE.txt' in files

					# Read and verify license content
					license_content = zf.read('LICENSE.txt').decode('utf-8')
					assert expected_license_text in license_content

					# Verify CITATION.cff has license info
					citation_content = zf.read('CITATION.cff').decode('utf-8')
					assert f'license: {license_enum.value}' in citation_content

					# Verify basic content inclusion
					assert any(f.startswith('ortho_') and f.endswith('.tif') for f in files)
					assert 'METADATA.csv' in files

	finally:
		# Cleanup the test datasets
		with use_client(auth_token) as supabase_client:
			for dataset_id in created_datasets:
				supabase_client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
				supabase_client.table(settings.orthos_table).delete().eq('dataset_id', dataset_id).execute()
				supabase_client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()

				# Cleanup downloaded files
				download_dir = settings.downloads_path / str(dataset_id)
				if download_dir.exists():
					shutil.rmtree(download_dir)

				# Cleanup archive files
				for license_enum, _ in licenses_to_test:
					file_name = f'test-download-{license_enum.value}.tif'
					archive_path = data_directory / settings.archive_path / file_name
					if archive_path.exists():
						archive_path.unlink()


@pytest.fixture(scope='function')
def test_dataset_with_invalid_geometries(auth_token, test_dataset_for_download, test_user):
	"""Create a test dataset with invalid (self-intersecting) geometries"""
	# Create a self-intersecting polygon (bowtie/figure-8 shape)
	# This creates coordinates that form a self-intersecting polygon
	invalid_geojson = {
		'type': 'MultiPolygon',
		'coordinates': [
			[
				[
					# Self-intersecting bowtie polygon
					[0.0, 0.0],
					[1.0, 1.0],
					[1.0, 0.0],
					[0.0, 1.0],
					[0.0, 0.0],  # Back to start, creating self-intersection
				]
			],
			[
				[
					# Another invalid polygon with duplicate consecutive points
					[2.0, 2.0],
					[2.0, 2.0],  # Duplicate point
					[3.0, 2.0],
					[3.0, 3.0],
					[2.0, 3.0],
					[2.0, 2.0],
				]
			],
		],
	}

	# Create AOI with invalid geometry too
	invalid_aoi_geojson = {
		'type': 'MultiPolygon',
		'coordinates': [
			[
				[
					# Invalid AOI with self-intersection
					[-1.0, -1.0],
					[4.0, 4.0],
					[4.0, -1.0],
					[-1.0, 4.0],
					[-1.0, -1.0],  # Self-intersecting
				]
			]
		],
	}

	# Create label payload with invalid geometries
	payload = LabelPayloadData(
		dataset_id=test_dataset_for_download,
		label_source=LabelSourceEnum.visual_interpretation,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.deadwood,
		label_quality=1,
		geometry=invalid_geojson,
		properties={'source': 'invalid_test'},
		# AOI fields with invalid geometry
		aoi_geometry=invalid_aoi_geojson,
		aoi_image_quality=1,
		aoi_notes='Test AOI with invalid geometry',
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
			if label.aoi_id:
				client.table(settings.aois_table).delete().eq('id', label.aoi_id).execute()

		client.table(settings.labels_table).delete().eq('dataset_id', test_dataset_for_download).execute()


@pytest.fixture(scope='function')
def test_dataset_with_large_complex_geometries(auth_token, test_dataset_for_download, test_user):
	"""Create a test dataset with very large and complex geometries that might cause size/memory issues"""

	# Create very large, complex MultiPolygon with many vertices
	# This simulates the kind of complex geometries that might cause issues in real datasets

	import math
	import random

	def create_large_complex_polygon(center_x, center_y, num_vertices=6000, radius=0.1):
		"""Create a large polygon with many vertices that may self-intersect, similar to dataset 3896"""
		coordinates = []
		angle_step = 2 * math.pi / num_vertices

		for i in range(num_vertices):
			angle = i * angle_step
			# Add significant randomness to create irregular shapes and guaranteed self-intersections
			r = radius * (1 + random.uniform(-0.8, 0.8))
			x = center_x + r * math.cos(angle)
			y = center_y + r * math.sin(angle)

			# Force self-intersections more frequently (every 50 points instead of 100)
			if i % 50 == 0:
				# Create more dramatic shifts that will cause intersections
				x += random.uniform(-0.2, 0.2)
				y += random.uniform(-0.2, 0.2)

			# Add occasional "spikes" that go far out and back, causing ring self-intersections
			if i % 200 == 0:
				spike_distance = radius * random.uniform(2.0, 4.0)
				spike_x = center_x + spike_distance * math.cos(angle)
				spike_y = center_y + spike_distance * math.sin(angle)
				coordinates.append([spike_x, spike_y])

			coordinates.append([x, y])

		# Close the polygon
		coordinates.append(coordinates[0])
		return coordinates

	# Create fewer but much more complex polygons that mirror the real problematic geometries
	complex_polygons = []

	# Create geometries similar to the ones found in dataset 3896
	problematic_vertex_counts = [6139, 4312, 4258, 3390, 3372]  # From actual dataset

	for i, vertex_count in enumerate(problematic_vertex_counts):
		center_x = i * 0.5
		center_y = i * 0.3
		poly_coords = create_large_complex_polygon(center_x, center_y, num_vertices=vertex_count)
		complex_polygons.append([poly_coords])

	# Add some explicitly self-intersecting large polygons
	def create_large_self_intersecting_polygon(num_segments=500):
		"""Create a large self-intersecting polygon"""
		coords = []
		for i in range(num_segments):
			# Create a pattern that will self-intersect
			angle = (i / num_segments) * 4 * math.pi  # Multiple loops
			radius = 0.5 + 0.3 * math.sin(i / 10)  # Varying radius
			x = radius * math.cos(angle)
			y = radius * math.sin(angle)
			coords.append([x, y])
		coords.append(coords[0])  # Close the polygon
		return coords

	# Add several large self-intersecting polygons
	for j in range(5):
		large_intersecting_coords = create_large_self_intersecting_polygon(num_segments=800 + j * 200)
		complex_polygons.append([large_intersecting_coords])

	large_complex_geojson = {'type': 'MultiPolygon', 'coordinates': complex_polygons}

	# Create large complex AOI as well
	large_aoi_coords = create_large_complex_polygon(0, 0, num_vertices=3000, radius=2.0)
	large_aoi_geojson = {'type': 'MultiPolygon', 'coordinates': [[large_aoi_coords]]}

	# Create label payload with large complex geometries
	payload = LabelPayloadData(
		dataset_id=test_dataset_for_download,
		label_source=LabelSourceEnum.visual_interpretation,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.deadwood,
		label_quality=1,
		geometry=large_complex_geojson,
		properties={'source': 'large_complex_test'},
		# AOI fields with large complex geometry
		aoi_geometry=large_aoi_geojson,
		aoi_image_quality=1,
		aoi_notes='Test AOI with large complex geometry',
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
			if label.aoi_id:
				client.table(settings.aois_table).delete().eq('id', label.aoi_id).execute()

		client.table(settings.labels_table).delete().eq('dataset_id', test_dataset_for_download).execute()


def test_download_dataset_with_large_complex_geometries(auth_token, test_dataset_with_large_complex_geometries):
	"""Test downloading a dataset with very large and complex geometries"""
	dataset_id = test_dataset_with_large_complex_geometries

	print(f'Testing dataset {dataset_id} with large complex geometries...')

	# Make initial request
	response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Check response format
	assert response.status_code == 200
	data = response.json()
	assert data['job_id'] == str(dataset_id)

	# Wait for processing - this might take longer with large geometries
	max_attempts = 15  # Increased attempts for large/complex geometries
	final_status = None

	for attempt in range(max_attempts):
		status_response = client.get(
			f'/api/v1/download/datasets/{dataset_id}/status',
			headers={'Authorization': f'Bearer {auth_token}'},
		)
		assert status_response.status_code == 200
		status_data = status_response.json()
		final_status = status_data['status']

		print(f'Attempt {attempt + 1}: Status = {final_status}')

		if final_status in ['completed', 'failed', 'error']:
			break

		# Wait longer between checks for complex processing
		time.sleep(3)

	# Log the final status for debugging
	print(f'Final status after {max_attempts} attempts: {final_status}')

	if final_status == 'completed':
		print('Download completed - checking if large geometries were processed successfully')

		# Verify the file exists
		download_file = settings.downloads_path / str(dataset_id) / f'{dataset_id}.zip'
		if download_file.exists():
			file_size = download_file.stat().st_size
			print(f'Download file size: {file_size / (1024 * 1024):.2f} MB')

			# Check ZIP contents
			with zipfile.ZipFile(download_file) as zf:
				files = zf.namelist()
				print(f'Files in ZIP: {files}')

				# Extract and check the labels file if it exists
				labels_files = [f for f in files if f.startswith('labels_') and f.endswith('.gpkg')]
				if labels_files:
					with tempfile.TemporaryDirectory() as tmpdir:
						labels_file = labels_files[0]
						zf.extract(labels_file, tmpdir)
						gpkg_path = Path(tmpdir) / labels_file

						try:
							# Try to read the exported geometries
							available_layers = fiona.listlayers(gpkg_path)
							print(f'Available layers: {available_layers}')

							if available_layers:
								gdf = gpd.read_file(gpkg_path, layer=available_layers[0])
								print(f'Successfully read {len(gdf)} geometries from exported file')

								# Check geometry statistics
								total_vertices = sum(
									len(geom.exterior.coords) if hasattr(geom, 'exterior') else 0
									for geom in gdf.geometry
								)
								print(f'Total vertices in exported geometries: {total_vertices}')

								# Check if geometries are valid after processing
								valid_geoms = gdf.geometry.is_valid.sum()
								total_geoms = len(gdf)
								print(f'Valid geometries: {valid_geoms}/{total_geoms}')

								# Check file size of the exported GeoPackage
								gpkg_size = gpkg_path.stat().st_size
								print(f'Exported GeoPackage size: {gpkg_size / (1024 * 1024):.2f} MB')

						except Exception as e:
							print(f'Error reading exported geometries: {e}')
							# This might be the error we're trying to reproduce
							pytest.fail(f'Failed to process large geometries: {e}')
		else:
			print('Download file not found despite completed status')

	elif final_status in ['failed', 'error']:
		print('Download failed - this might be due to geometry size/complexity issues')
		# Get more details about the failure if available
		status_response = client.get(
			f'/api/v1/download/datasets/{dataset_id}/status',
			headers={'Authorization': f'Bearer {auth_token}'},
		)
		status_data = status_response.json()
		if 'error' in status_data:
			print(f'Error details: {status_data["error"]}')

		# This reproduces a size/complexity-related error
		pytest.fail(
			f'Download failed with status: {final_status}. This might reproduce the size-related geometry error.'
		)

	else:
		pytest.fail(f'Dataset processing did not complete within expected time. Final status: {final_status}')


def test_download_dataset_with_invalid_geometries(auth_token, test_dataset_with_invalid_geometries):
	"""Test downloading a dataset with invalid geometries to reproduce the error"""
	dataset_id = test_dataset_with_invalid_geometries

	# Make initial request
	response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Check response format
	assert response.status_code == 200
	data = response.json()
	assert data['job_id'] == str(dataset_id)

	# Wait for processing - this should either complete with error handling or fail
	max_attempts = 10  # Increased attempts since processing might take longer with errors
	final_status = None

	for attempt in range(max_attempts):
		status_response = client.get(
			f'/api/v1/download/datasets/{dataset_id}/status',
			headers={'Authorization': f'Bearer {auth_token}'},
		)
		assert status_response.status_code == 200
		status_data = status_response.json()
		final_status = status_data['status']

		print(f'Attempt {attempt + 1}: Status = {final_status}')

		if final_status in ['completed', 'failed', 'error']:
			break

		# Wait before checking again
		time.sleep(2)

	# Log the final status for debugging
	print(f'Final status after {max_attempts} attempts: {final_status}')

	# The test should either:
	# 1. Complete successfully (if error handling works)
	# 2. Fail with a specific error (reproducing the original issue)
	# 3. Timeout (indicating the process is stuck)

	if final_status == 'completed':
		print('Download completed - checking if files were created with handled invalid geometries')

		# Verify the file exists
		download_file = settings.downloads_path / str(dataset_id) / f'{dataset_id}.zip'
		if download_file.exists():
			# Check ZIP contents to see how invalid geometries were handled
			with zipfile.ZipFile(download_file) as zf:
				files = zf.namelist()
				print(f'Files in ZIP: {files}')

				# Extract and check the labels file if it exists
				labels_files = [f for f in files if f.startswith('labels_') and f.endswith('.gpkg')]
				if labels_files:
					with tempfile.TemporaryDirectory() as tmpdir:
						labels_file = labels_files[0]
						zf.extract(labels_file, tmpdir)
						gpkg_path = Path(tmpdir) / labels_file

						try:
							# Try to read the exported geometries
							available_layers = fiona.listlayers(gpkg_path)
							print(f'Available layers: {available_layers}')

							if available_layers:
								gdf = gpd.read_file(gpkg_path, layer=available_layers[0])
								print(f'Successfully read {len(gdf)} geometries from exported file')

								# Check if geometries are now valid (fixed during export)
								valid_geoms = gdf.geometry.is_valid.sum()
								total_geoms = len(gdf)
								print(f'Valid geometries: {valid_geoms}/{total_geoms}')

						except Exception as e:
							print(f'Error reading exported geometries: {e}')
							# This might be the error we're trying to reproduce
							raise
		else:
			print('Download file not found despite completed status')

	elif final_status in ['failed', 'error']:
		print('Download failed - this might be reproducing the original error')
		# Get more details about the failure if available
		status_response = client.get(
			f'/api/v1/download/datasets/{dataset_id}/status',
			headers={'Authorization': f'Bearer {auth_token}'},
		)
		status_data = status_response.json()
		if 'error' in status_data:
			print(f'Error details: {status_data["error"]}')

		# This is actually what we expect - the test should fail due to invalid geometries
		pytest.fail(f'Download failed with status: {final_status}. This reproduces the invalid geometry error.')

	else:
		pytest.fail(f'Dataset processing did not complete within expected time. Final status: {final_status}')


def test_download_large_dataset_with_pagination(auth_token, test_dataset_with_large_complex_geometries):
	"""Test downloading a dataset with many geometries to verify pagination works correctly"""
	dataset_id = test_dataset_with_large_complex_geometries

	print(f'Testing download with pagination for dataset {dataset_id}')

	# Make initial request to start the download (using async pattern like other tests)
	response = client.get(
		f'/api/v1/download/datasets/{dataset_id}/dataset.zip',
		headers={'Authorization': f'Bearer {auth_token}'},
	)

	# Check response format
	assert response.status_code == 200
	data = response.json()
	assert 'status' in data
	assert 'job_id' in data
	assert data['job_id'] == str(dataset_id)

	# Wait for processing to complete
	max_attempts = 15  # Increased for large datasets
	final_status = None

	for attempt in range(max_attempts):
		status_response = client.get(
			f'/api/v1/download/datasets/{dataset_id}/status',
			headers={'Authorization': f'Bearer {auth_token}'},
		)
		assert status_response.status_code == 200
		status_data = status_response.json()
		final_status = status_data['status']

		print(f'Attempt {attempt + 1}: Status = {final_status}')

		if final_status == 'completed':
			download_path = status_data['download_path']
			print(f'✅ Large dataset download completed with pagination! Download path: {download_path}')
			break

		if final_status in ['failed', 'error']:
			if 'error' in status_data:
				print(f'Error details: {status_data["error"]}')
			pytest.fail(f'Download failed with status: {final_status}')

		# Wait before checking again
		time.sleep(2)
	else:
		pytest.fail(f'Dataset processing did not complete within expected time. Final status: {final_status}')

	# Verify the file exists in downloads directory
	download_file = settings.downloads_path / str(dataset_id) / f'{dataset_id}.zip'
	assert download_file.exists()

	# Verify ZIP contents
	with zipfile.ZipFile(download_file) as zf:
		files = zf.namelist()
		print(f'Files in download ZIP: {files}')

		# Should contain expected files
		assert any(f.startswith('ortho_') and f.endswith('.tif') for f in files)
		assert any(f.startswith('labels_') and f.endswith('.gpkg') for f in files)
		assert 'METADATA.csv' in files
		assert 'LICENSE.txt' in files
		assert 'CITATION.cff' in files

		# Extract and verify the labels file contains many geometries
		labels_file = next(f for f in files if f.startswith('labels_') and f.endswith('.gpkg'))
		with tempfile.TemporaryDirectory() as tmpdir:
			zf.extract(labels_file, tmpdir)
			gpkg_path = Path(tmpdir) / labels_file

			# Check the layers and geometry count
			available_layers = fiona.listlayers(gpkg_path)
			print(f'Available layers: {available_layers}')

			if available_layers:
				gdf = gpd.read_file(gpkg_path, layer=available_layers[0])
				print(f'Successfully read {len(gdf)} geometries from exported file using pagination')

				# This should be a large number if our complex geometry fixture worked
				assert len(gdf) > 0
