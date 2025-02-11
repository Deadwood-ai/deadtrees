import pytest
from pathlib import Path
import zipfile
from shapely.geometry import Polygon
import shutil

from shared.db import use_client
from shared.settings import settings
from fastapi.testclient import TestClient
from api.src.server import app
from shared.models import StatusEnum, LicenseEnum, PlatformEnum, DatasetAccessEnum
from api.src.download.cleanup import cleanup_downloads_directory

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
			'file_size': archive_path.stat().st_size,
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


# @pytest.fixture(scope='function')
# def test_dataset_with_label(auth_token, data_directory, test_geotiff, test_user):
# 	"""Create a temporary test dataset with metadata and label for testing downloads"""
# 	with use_client(auth_token) as client:
# 		# Copy test file to archive directory
# 		file_name = 'test-download-label.tif'
# 		archive_path = data_directory / settings.ARCHIVE_DIR / file_name
# 		shutil.copy2(test_geotiff, archive_path)

# 		dataset_data = {
# 			'file_name': file_name,
# 			'file_alias': file_name,
# 			'file_size': archive_path.stat().st_size,
# 			'copy_time': 123,
# 			'user_id': test_user,
# 			'status': StatusEnum.idle.value,
# 		}
# 		response = client.table(settings.datasets_table).insert(dataset_data).execute()
# 		dataset_id = response.data[0]['id']

# 		# Create metadata
# 		metadata_data = {
# 			'dataset_id': dataset_id,
# 			'name': 'Test Dataset',
# 			'user_id': test_user,
# 			'authors': 'Test Author',
# 			'admin_level_1': 'Test Admin Level 1',
# 			'admin_level_2': 'Test Admin Level 2',
# 			'admin_level_3': 'Test Admin Level 3',
# 			'platform': 'drone',
# 			'data_access': 'public',
# 			'license': 'CC BY',
# 			'aquisition_year': 2024,
# 			'aquisition_month': 1,
# 			'aquisition_day': 1,
# 		}
# 		client.table(settings.metadata_table).insert(metadata_data).execute()

# 		# Create status entry
# 		status_data = {
# 			'dataset_id': dataset_id,
# 			'current_status': StatusEnum.idle.value,
# 			'is_upload_done': True,
# 			'is_ortho_done': True,
# 		}
# 		client.table(settings.statuses_table).insert(status_data).execute()

# 		# Create a simple polygon for the label
# 		polygon = Polygon([[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]])
# 		multipolygon_geojson = {
# 			'type': 'MultiPolygon',
# 			'coordinates': [[polygon.exterior.coords[:]]],
# 		}
# 		label_multipolygon = {
# 			'type': 'MultiPolygon',
# 			'coordinates': [[[[0, 0], [0, 0.5], [0.5, 0.5], [0.5, 0], [0, 0]]]],
# 		}

# 		# Create label
# 		label_data = {
# 			'dataset_id': dataset_id,
# 			'user_id': test_user,
# 			'aoi': multipolygon_geojson,
# 			'label': label_multipolygon,
# 			'label_source': 'visual_interpretation',
# 			'label_quality': 1,
# 			'label_type': 'segmentation',
# 		}
# 		client.table(settings.labels_table).insert(label_data).execute()

# 		yield dataset_id

# 		# Cleanup
# 		client.table(settings.labels_table).delete().eq('dataset_id', dataset_id).execute()
# 		client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
# 		client.table(settings.metadata_table).delete().eq('dataset_id', dataset_id).execute()
# 		client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()
# 		if archive_path.exists():
# 			archive_path.unlink()


# def test_download_dataset_with_labels(auth_token, test_dataset_with_label):
# 	"""Test downloading a dataset that includes labels"""
# 	response = client.get(
# 		f'/download/datasets/{test_dataset_with_label}/dataset.zip',
# 		headers={'Authorization': f'Bearer {auth_token}'},
# 		follow_redirects=True,
# 	)

# 	# Check response status
# 	assert response.status_code == 200
# 	assert response.headers['content-type'] == 'application/zip'

# 	# Save response content to temporary file and verify ZIP contents
# 	temp_zip = Path('test_download_with_labels.zip')
# 	try:
# 		temp_zip.write_bytes(response.content)

# 		with zipfile.ZipFile(temp_zip) as zf:
# 			# List all files in the ZIP
# 			files = zf.namelist()
# 			# Check for files with new naming pattern
# 			assert any(f.startswith('ortho_') and f.endswith('.tif') for f in files)
# 			assert any(f.startswith('labels_') and f.endswith('.gpkg') for f in files)
# 			assert 'METADATA.csv' in files
# 			assert 'CITATION.cff' in files
# 			assert 'LICENSE.txt' in files

# 	finally:
# 		# Cleanup
# 		if temp_zip.exists():
# 			temp_zip.unlink()
