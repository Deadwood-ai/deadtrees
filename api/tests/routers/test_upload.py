import pytest
from pathlib import Path
import tempfile
import shutil
from fastapi.testclient import TestClient
from api.src.server import app
from shared.supabase import login, use_client
from shared.settings import settings

client = TestClient(app)


def test_upload_geotiff_chunk(test_geotiff, auth_token, test_user):
	"""Test chunked upload of a GeoTIFF file"""
	# Setup
	chunk_size = 1024 * 256  # 1KB chunks for testing
	file_size = test_geotiff.stat().st_size
	chunks_total = (file_size + chunk_size - 1) // chunk_size
	upload_id = 'test-upload-id'

	# Read file in chunks and upload each chunk
	with open(test_geotiff, 'rb') as f:
		for chunk_index in range(chunks_total):
			chunk_data = f.read(chunk_size)

			# Prepare multipart form data
			files = {'file': ('test-data-small.tif', chunk_data, 'application/octet-stream')}
			data = {
				'chunk_index': str(chunk_index),
				'chunks_total': str(chunks_total),
				'filename': test_geotiff.name,
				'copy_time': '0',
				'upload_id': upload_id,
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

				# Verify database entry
				assert 'id' in dataset
				assert dataset['file_alias'] == test_geotiff.name
				assert dataset['status'] == 'uploaded'
				assert dataset['file_size'] > 0
				assert dataset['bbox'] is not None
				assert dataset['sha256'] is not None
				assert dataset['user_id'] == test_user

				# Verify file exists in archive directory and has correct ID-based name
				expected_filename = f'{dataset_id}_ortho.tif'
				assert dataset['file_name'] == expected_filename
				archive_path = Path(settings.BASE_DIR) / settings.ARCHIVE_DIR / expected_filename
				assert archive_path.exists()
				assert archive_path.stat().st_size == file_size

				# Verify GeoTIFF info
				with use_client(auth_token) as supabase_client:
					response = (
						supabase_client.table(settings.geotiff_info_table)
						.select('*')
						.eq('dataset_id', dataset_id)
						.execute()
					)
					assert len(response.data) == 1
					geotiff_info = response.data[0]
					assert geotiff_info['dataset_id'] == dataset_id
					assert geotiff_info['driver'] == 'GTiff'
					assert geotiff_info['size_width'] > 0
					assert geotiff_info['size_height'] > 0
					assert geotiff_info['band_count'] > 0

				# Cleanup
				with use_client(auth_token) as supabase_client:
					supabase_client.table(settings.metadata_table).delete().eq('dataset_id', dataset_id).execute()
					supabase_client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()


def test_upload_without_auth():
	"""Test upload attempt without authentication"""
	response = client.post(
		'/datasets/chunk',
		files={'file': ('test.tif', b'test data', 'application/octet-stream')},
		data={
			'chunk_index': '0',
			'chunks_total': '1',
			'filename': 'test.tif',
			'copy_time': '0',
			'upload_id': 'test',
		},
	)
	assert response.status_code == 401
