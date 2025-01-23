import pytest
from pathlib import Path
import tempfile
import shutil
from fastapi.testclient import TestClient
from api.src.server import app
from shared.db import login, use_client
from shared.settings import settings
from shared.models import StatusEnum, LicenseEnum, PlatformEnum, DatasetAccessEnum

client = TestClient(app)


def test_upload_geotiff_chunk(test_geotiff, auth_token, test_user):
	"""Test chunked upload of a GeoTIFF file"""
	# Setup
	chunk_size = 1024 * 256  # 256KB chunks for testing
	file_size = test_geotiff.stat().st_size
	chunks_total = (file_size + chunk_size - 1) // chunk_size
	upload_id = 'test-upload-id'

	# Required form data
	form_data = {
		'license': LicenseEnum.cc_by.value,
		'platform': PlatformEnum.drone.value,
		'authors': 'Test Author 1, Test Author 2',
		'data_access': DatasetAccessEnum.public.value,
		'aquisition_year': '2023',
		'aquisition_month': '12',
		'aquisition_day': '25',
		'additional_information': 'Test upload',
	}

	dataset_id = None
	# try:
	# Read file in chunks and upload each chunk
	with open(test_geotiff, 'rb') as f:
		for chunk_index in range(chunks_total):
			chunk_data = f.read(chunk_size)

			# Prepare multipart form data
			files = {'file': (f'{test_geotiff.name}', chunk_data, 'application/octet-stream')}
			data = {
				'chunk_index': str(chunk_index),
				'chunks_total': str(chunks_total),
				'upload_id': upload_id,
				'file': test_geotiff.name,
				**form_data,
			}

			# Make request
			response = client.post(
				'/datasets/chunk', files=files, data=data, headers={'Authorization': f'Bearer {auth_token}'}
			)

			# Check response
			assert response.status_code == 200

			if chunk_index < chunks_total - 1:
				assert response.json() == {'message': f'Chunk {chunk_index} of {chunks_total} received'}
			else:
				# For final chunk, check dataset response
				dataset = response.json()
				dataset_id = dataset['id']

				# Verify dataset entry
				assert 'id' in dataset
				assert dataset['license'] == form_data['license']
				assert dataset['platform'] == form_data['platform']
				assert dataset['authors'] == ['Test Author 1', 'Test Author 2']
				assert dataset['user_id'] == test_user
				assert dataset['aquisition_year'] == int(form_data['aquisition_year'])

				# Verify file exists with correct name
				assert dataset['file_name'] == test_geotiff.name
				expected_filename = f'{dataset_id}_ortho.tif'
				archive_path = settings.archive_path / expected_filename
				assert archive_path.exists()
				assert archive_path.stat().st_size == file_size

				# Verify ortho entry
				with use_client(auth_token) as supabase_client:
					ortho_response = (
						supabase_client.table(settings.orthos_table).select('*').eq('dataset_id', dataset_id).execute()
					)
					assert len(ortho_response.data) == 1
					ortho = ortho_response.data[0]
					assert ortho['dataset_id'] == dataset_id
					assert ortho['ortho_file_name'] == expected_filename
					assert ortho['file_size'] == file_size
					assert ortho['bbox'] is not None
					assert ortho['sha256'] is not None
					assert ortho['version'] == 1

				# Verify final status
				with use_client(auth_token) as supabase_client:
					status_response = (
						supabase_client.table(settings.statuses_table)
						.select('*')
						.eq('dataset_id', dataset_id)
						.execute()
					)
					assert len(status_response.data) == 1
					status = status_response.data[0]
					assert status['current_status'] == StatusEnum.idle.value
					assert status['is_upload_done'] is True
					assert status['has_error'] is False

	# finally:
	# 	# Cleanup
	# 	if dataset_id:
	# 		with use_client(auth_token) as supabase_client:
	# 			supabase_client.table(settings.statuses_table).delete().eq('dataset_id', dataset_id).execute()
	# 			supabase_client.table(settings.orthos_table).delete().eq('dataset_id', dataset_id).execute()
	# 			supabase_client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_upload_without_auth():
	"""Test upload attempt without authentication"""
	response = client.post(
		'/datasets/chunk',
		files={'file': ('test.tif', b'test data', 'application/octet-stream')},
		data={
			'chunk_index': '0',
			'chunks_total': '1',
			'filename': 'test.tif',
			'upload_id': 'test',
			'license': LicenseEnum.cc_by.value,
			'platform': PlatformEnum.drone.value,
			'authors': 'Test Author',
		},
	)
	assert response.status_code == 401
