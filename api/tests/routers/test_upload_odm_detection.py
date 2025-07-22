import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from api.src.server import app
from api.src.utils.file_utils import detect_upload_type, UploadType
from shared.models import LicenseEnum, PlatformEnum, DatasetAccessEnum

client = TestClient(app)


def test_detect_upload_type_geotiff():
	"""Test detect_upload_type with .tif and .tiff files"""
	assert detect_upload_type('test_file.tif') == UploadType.GEOTIFF
	assert detect_upload_type('test_file.tiff') == UploadType.GEOTIFF
	assert detect_upload_type('TEST_FILE.TIF') == UploadType.GEOTIFF
	assert detect_upload_type('TEST_FILE.TIFF') == UploadType.GEOTIFF


def test_detect_upload_type_zip():
	"""Test detect_upload_type with .zip files"""
	assert detect_upload_type('test_file.zip') == UploadType.RAW_IMAGES_ZIP
	assert detect_upload_type('TEST_FILE.ZIP') == UploadType.RAW_IMAGES_ZIP


def test_detect_upload_type_unsupported():
	"""Test detect_upload_type with unsupported file types"""
	with pytest.raises(HTTPException) as exc_info:
		detect_upload_type('test_file.txt')
	assert exc_info.value.status_code == 400
	assert 'Unsupported file type: .txt' in exc_info.value.detail

	with pytest.raises(HTTPException) as exc_info:
		detect_upload_type('test_file.jpg')
	assert exc_info.value.status_code == 400
	assert 'Unsupported file type: .jpg' in exc_info.value.detail


def test_chunk_endpoint_accepts_upload_type_parameter(auth_token):
	"""Test enhanced chunk endpoint accepts upload_type parameter"""
	# Required form data
	form_data = {
		'chunk_index': '0',
		'chunks_total': '2',  # Make it not the final chunk
		'upload_id': 'test-upload-id',
		'license': LicenseEnum.cc_by.value,
		'platform': PlatformEnum.drone.value,
		'authors': ['Test Author'],
		'data_access': DatasetAccessEnum.public.value,
		'upload_type': UploadType.GEOTIFF.value,
	}

	# Test with GEOTIFF upload_type (should work with existing logic)
	files = {'file': ('test.tif', b'test data', 'image/tiff')}
	response = client.post(
		'/datasets/chunk', files=files, data=form_data, headers={'Authorization': f'Bearer {auth_token}'}
	)

	# Should get a successful response for first chunk
	assert response.status_code == 200
	assert response.json() == {'message': 'Chunk 0 of 2 received'}


def test_chunk_endpoint_zip_upload_type_not_implemented(auth_token):
	"""Test chunk endpoint with ZIP upload_type returns 501 Not Implemented"""
	# Required form data
	form_data = {
		'chunk_index': '0',
		'chunks_total': '1',
		'upload_id': 'test-upload-id',
		'license': LicenseEnum.cc_by.value,
		'platform': PlatformEnum.drone.value,
		'authors': ['Test Author'],
		'data_access': DatasetAccessEnum.public.value,
		'upload_type': UploadType.RAW_IMAGES_ZIP.value,
	}

	files = {'file': ('test.zip', b'test zip data', 'application/zip')}
	response = client.post(
		'/datasets/chunk', files=files, data=form_data, headers={'Authorization': f'Bearer {auth_token}'}
	)

	# Should return 501 Not Implemented for ZIP processing
	assert response.status_code == 501
	assert 'ZIP processing not yet implemented' in response.json()['detail']


def test_backward_compatibility_auto_detection(auth_token):
	"""Test backward compatibility - auto-detect upload type when not provided"""
	# Required form data without upload_type parameter
	form_data = {
		'chunk_index': '0',
		'chunks_total': '2',  # Make it not the final chunk
		'upload_id': 'test-upload-id-compat',
		'license': LicenseEnum.cc_by.value,
		'platform': PlatformEnum.drone.value,
		'authors': ['Test Author'],
		'data_access': DatasetAccessEnum.public.value,
	}

	# Test with .tif file - should auto-detect as GEOTIFF and work normally
	files = {'file': ('test_compat.tif', b'test data', 'image/tiff')}
	response = client.post(
		'/datasets/chunk', files=files, data=form_data, headers={'Authorization': f'Bearer {auth_token}'}
	)

	# Should work exactly as before
	assert response.status_code == 200
	assert response.json() == {'message': 'Chunk 0 of 2 received'}


def test_backward_compatibility_zip_auto_detection(auth_token):
	"""Test backward compatibility - auto-detect ZIP type should return 501"""
	# Required form data without upload_type parameter
	form_data = {
		'chunk_index': '0',
		'chunks_total': '1',
		'upload_id': 'test-upload-id-zip-compat',
		'license': LicenseEnum.cc_by.value,
		'platform': PlatformEnum.drone.value,
		'authors': ['Test Author'],
		'data_access': DatasetAccessEnum.public.value,
	}

	# Test with .zip file - should auto-detect as RAW_IMAGES_ZIP and return 501
	files = {'file': ('test_compat.zip', b'test zip data', 'application/zip')}
	response = client.post(
		'/datasets/chunk', files=files, data=form_data, headers={'Authorization': f'Bearer {auth_token}'}
	)

	# Should auto-detect and return 501 for ZIP processing
	assert response.status_code == 501
	assert 'ZIP processing not yet implemented' in response.json()['detail']


def test_backward_compatibility_unsupported_auto_detection(auth_token):
	"""Test backward compatibility - auto-detect unsupported type should return 400"""
	# Required form data without upload_type parameter
	form_data = {
		'chunk_index': '0',
		'chunks_total': '1',
		'upload_id': 'test-upload-id-unsupported',
		'license': LicenseEnum.cc_by.value,
		'platform': PlatformEnum.drone.value,
		'authors': ['Test Author'],
		'data_access': DatasetAccessEnum.public.value,
	}

	# Test with unsupported file type - should return 400
	files = {'file': ('test_unsupported.txt', b'test data', 'text/plain')}
	response = client.post(
		'/datasets/chunk', files=files, data=form_data, headers={'Authorization': f'Bearer {auth_token}'}
	)

	# Should return 400 for unsupported file type
	assert response.status_code == 400
	assert 'Unsupported file type: .txt' in response.json()['detail']


def test_chunk_endpoint_without_auth():
	"""Test chunk endpoint without authentication returns 401"""
	form_data = {
		'chunk_index': '0',
		'chunks_total': '1',
		'upload_id': 'test-upload-id',
		'license': LicenseEnum.cc_by.value,
		'platform': PlatformEnum.drone.value,
		'authors': ['Test Author'],
		'upload_type': UploadType.GEOTIFF.value,
	}

	files = {'file': ('test.tif', b'test data', 'image/tiff')}
	response = client.post('/datasets/chunk', files=files, data=form_data)

	assert response.status_code == 401
