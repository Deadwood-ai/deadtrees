# import pytest
# from fastapi.testclient import TestClient
# from shapely.geometry import Polygon
# import io
# from pathlib import Path
# import shutil

# from api.src.server import app
# from shared.db import use_client
# from shared.settings import settings
# from shared.models import LabelPayloadData, LabelSourceEnum, LabelTypeEnum

# # Initialize the test client globally
# client = TestClient(app)


# @pytest.fixture(scope='function')
# def test_dataset_for_labels(auth_token, data_directory, test_geotiff, test_user):
# 	"""Create a temporary test dataset for label testing"""
# 	with use_client(auth_token) as client:
# 		# Copy test file to archive directory
# 		file_name = 'test-labels.tif'
# 		archive_path = data_directory / settings.ARCHIVE_DIR / file_name
# 		shutil.copy2(test_geotiff, archive_path)

# 		# Create test dataset
# 		dataset_data = {
# 			'file_name': file_name,
# 			'file_alias': file_name,
# 			'file_size': archive_path.stat().st_size,
# 			'copy_time': 123,
# 			'user_id': test_user,
# 			'status': 'uploaded',
# 		}
# 		response = client.table(settings.datasets_table).insert(dataset_data).execute()
# 		dataset_id = response.data[0]['id']

# 		try:
# 			yield dataset_id
# 		finally:
# 			# Cleanup database entries
# 			client.table(settings.labels_table).delete().eq('dataset_id', dataset_id).execute()
# 			client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()
# 			# Cleanup file
# 			if archive_path.exists():
# 				archive_path.unlink()


# @pytest.fixture(scope='function')
# def mock_label_file():
# 	"""Create a mock file for testing label uploads"""
# 	return io.BytesIO(b'mock label data')


# def test_create_label(test_dataset_for_labels, auth_token, test_user):
# 	"""Test creating a new label for a dataset"""
# 	# Create a simple polygon for testing
# 	polygon = Polygon([[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]])

# 	# Convert to MultiPolygon GeoJSON format
# 	multipolygon_geojson = {
# 		'type': 'MultiPolygon',
# 		'coordinates': [[polygon.exterior.coords[:]]],
# 	}

# 	# Create a label MultiPolygon (same structure as AOI)
# 	label_multipolygon = {
# 		'type': 'MultiPolygon',
# 		'coordinates': [[[[0, 0], [0, 0.5], [0.5, 0.5], [0.5, 0], [0, 0]]]],
# 	}

# 	# Prepare test label data
# 	label_payload = LabelPayloadData(
# 		aoi=multipolygon_geojson,
# 		label=label_multipolygon,
# 		label_source=LabelSourceEnum.visual_interpretation,
# 		label_quality=1,
# 		label_type=LabelTypeEnum.segmentation,
# 	)

# 	# Make request to create label
# 	response = client.post(
# 		f'/datasets/{test_dataset_for_labels}/labels',
# 		json=label_payload.model_dump(),
# 		headers={'Authorization': f'Bearer {auth_token}'},
# 	)

# 	# Check response
# 	assert response.status_code == 200
# 	data = response.json()

# 	# Verify the label was correctly saved
# 	assert data['dataset_id'] == test_dataset_for_labels
# 	assert data['user_id'] == test_user
# 	assert data['label_source'] == label_payload.label_source
# 	assert data['label_quality'] == label_payload.label_quality
# 	assert data['label_type'] == label_payload.label_type
# 	assert 'aoi' in data
# 	assert 'label' in data


# def test_create_label_unauthorized():
# 	"""Test label creation without authentication"""
# 	response = client.post(
# 		'/datasets/1/labels',
# 		json={},
# 	)
# 	assert response.status_code == 401


# def test_create_label_invalid_dataset(auth_token):
# 	"""Test label creation for non-existent dataset"""
# 	polygon = Polygon([[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]])
# 	multipolygon_geojson = {'type': 'MultiPolygon', 'coordinates': [[polygon.exterior.coords[:]]]}
# 	label_multipolygon = {'type': 'MultiPolygon', 'coordinates': [[[[0, 0], [0, 0.5], [0.5, 0.5], [0.5, 0], [0, 0]]]]}

# 	label_payload = LabelPayloadData(
# 		aoi=multipolygon_geojson,
# 		label=label_multipolygon,
# 		label_source=LabelSourceEnum.visual_interpretation,
# 		label_quality=1,
# 		label_type=LabelTypeEnum.segmentation,
# 	)

# 	response = client.post(
# 		'/datasets/99999/labels',
# 		json=label_payload.model_dump(),
# 		headers={'Authorization': f'Bearer {auth_token}'},
# 	)
# 	assert response.status_code == 404


# def test_upload_user_labels(test_dataset_for_labels, auth_token, mock_label_file, test_user):
# 	"""Test uploading user labels"""
# 	form_data = {
# 		'user_id': test_user,
# 		'file_type': 'geojson',
# 		'file_alias': 'test_labels',
# 		'label_description': 'Test label description',
# 	}

# 	files = {'file': ('test_labels.geojson', mock_label_file, 'application/json')}

# 	response = client.post(
# 		f'/datasets/{test_dataset_for_labels}/user-labels',
# 		data=form_data,
# 		files=files,
# 		headers={'Authorization': f'Bearer {auth_token}'},
# 	)

# 	assert response.status_code == 200
# 	data = response.json()

# 	# Verify the response data
# 	assert data['dataset_id'] == test_dataset_for_labels
# 	assert data['user_id'] == test_user
# 	assert data['file_type'] == form_data['file_type']
# 	assert data['file_alias'] == form_data['file_alias']
# 	assert data['label_description'] == form_data['label_description']
# 	assert data['audited'] == False
# 	assert 'file_path' in data

# 	# Cleanup: Remove created file and database entry
# 	with use_client(auth_token) as supabaseClient:
# 		supabaseClient.table(settings.label_objects_table).delete().eq('dataset_id', test_dataset_for_labels).execute()

# 	if Path(data['file_path']).exists():
# 		Path(data['file_path']).unlink()


# def test_upload_user_labels_unauthorized(test_dataset_for_labels, mock_label_file, test_user):
# 	"""Test user label upload without authentication"""
# 	form_data = {
# 		'user_id': test_user,
# 		'file_type': 'geojson',
# 		'file_alias': 'test_labels',
# 		'label_description': 'Test label description',
# 	}

# 	files = {'file': ('test_labels.geojson', mock_label_file, 'application/json')}

# 	response = client.post(
# 		f'/datasets/{test_dataset_for_labels}/user-labels',
# 		data=form_data,
# 		files=files,
# 	)
# 	assert response.status_code == 401


# def test_upload_user_labels_invalid_dataset(auth_token, mock_label_file, test_user):
# 	"""Test user label upload for non-existent dataset"""
# 	form_data = {
# 		'user_id': test_user,
# 		'file_type': 'geojson',
# 		'file_alias': 'test_labels',
# 		'label_description': 'Test label description',
# 	}

# 	files = {'file': ('test_labels.geojson', mock_label_file, 'application/json')}

# 	response = client.post(
# 		'/datasets/99999/user-labels',
# 		data=form_data,
# 		files=files,
# 		headers={'Authorization': f'Bearer {auth_token}'},
# 	)
# 	assert response.status_code == 404
