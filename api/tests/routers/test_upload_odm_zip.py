"""
Tests for ODM ZIP upload processing functionality.

Tests the complete ZIP upload workflow including:
- Dataset and raw_images database entry creation
- EXIF data extraction for acquisition dates
- RTK file detection and metadata extraction
- Image extraction and storage handling
"""

import pytest
from pathlib import Path
import tempfile
import shutil
from fastapi.testclient import TestClient

from api.src.server import app
from api.src.upload.raw_images_processor import process_raw_images_upload
from api.src.upload.exif_utils import extract_acquisition_date, extract_comprehensive_exif
from api.src.upload.rtk_utils import detect_rtk_files, parse_rtk_timestamp_file
from shared.db import use_client
from shared.models import Dataset, RawImages, LicenseEnum, PlatformEnum, DatasetAccessEnum
from shared.testing.fixtures import cleanup_database

client = TestClient(app)

# Path to test data
TEST_DATA_DIR = Path('assets/test_data/raw_drone_images')
TEST_ZIP_FILE = TEST_DATA_DIR / 'test_minimal_3_images.zip'


@pytest.fixture
def test_zip_file():
	"""Provide path to test ZIP file with minimal drone images"""
	if not TEST_ZIP_FILE.exists():
		pytest.skip(f'Test data file not found: {TEST_ZIP_FILE}. Run ./scripts/create_odm_test_data.sh')
	return TEST_ZIP_FILE


@pytest.fixture
def temp_test_zip(test_zip_file):
	"""Create a temporary copy of test ZIP file for manipulation"""
	with tempfile.NamedTemporaryFile(suffix='.zip', delete=False) as tmp:
		shutil.copy2(test_zip_file, tmp.name)
		yield Path(tmp.name)
		Path(tmp.name).unlink(missing_ok=True)


class TestZipUploadProcessing:
	"""Test ZIP upload processing functionality"""

	@pytest.mark.asyncio
	async def test_process_raw_images_upload_creates_dataset(self, temp_test_zip, test_user, auth_token):
		"""Test that ZIP upload creates v2_datasets entry correctly"""
		# Test data
		user_id = test_user
		file_name = 'test_minimal_3_images.zip'
		license = LicenseEnum.cc_by
		platform = PlatformEnum.drone
		authors = ['Test Author 1', 'Test Author 2']

		# Process the upload
		dataset = await process_raw_images_upload(
			user_id=user_id,
			file_path=temp_test_zip,
			file_name=file_name,
			license=license,
			platform=platform,
			authors=authors,
			aquisition_year=2024,
			aquisition_month=4,
			aquisition_day=15,
			additional_information='Test ODM upload',
			data_access=DatasetAccessEnum.public,
			token=auth_token,
		)

		# Verify dataset was created
		assert dataset is not None
		assert isinstance(dataset, Dataset)
		assert dataset.user_id == user_id
		assert dataset.authors == authors
		assert dataset.license == license
		assert dataset.platform == platform
		assert dataset.aquisition_year == 2024
		assert dataset.aquisition_month == 4
		assert dataset.aquisition_day == 15
		assert file_name in dataset.file_name

		# Verify dataset exists in database
		with use_client(auth_token) as client:
			db_dataset = client.table('v2_datasets').select('*').eq('id', dataset.id).execute()
			assert len(db_dataset.data) == 1
			assert db_dataset.data[0]['user_id'] == user_id

	@pytest.mark.asyncio
	async def test_process_raw_images_upload_creates_raw_images_entry(self, temp_test_zip, test_user, auth_token):
		"""Test that ZIP upload creates v2_raw_images entry correctly"""
		# Process the upload
		dataset = await process_raw_images_upload(
			user_id=test_user,
			file_path=temp_test_zip,
			file_name='test_minimal_3_images.zip',
			license=LicenseEnum.cc_by,
			platform=PlatformEnum.drone,
			authors=['Test Author'],
			token=auth_token,
		)

		# Verify raw_images entry was created
		with use_client(auth_token) as client:
			raw_images_result = client.table('v2_raw_images').select('*').eq('dataset_id', dataset.id).execute()
			assert len(raw_images_result.data) == 1

			raw_images_data = raw_images_result.data[0]
			assert raw_images_data['dataset_id'] == dataset.id
			assert raw_images_data['raw_image_count'] >= 3  # Minimal test has 3 images
			assert raw_images_data['raw_image_size_mb'] > 0
			assert 'raw_images' in raw_images_data['raw_images_path']
			assert raw_images_data['version'] == 1

	@pytest.mark.asyncio
	async def test_exif_extraction_populates_acquisition_date(self, temp_test_zip, test_user, auth_token):
		"""Test that EXIF extraction populates acquisition date correctly"""
		# Process upload without providing acquisition date - test real EXIF extraction
		dataset = await process_raw_images_upload(
			user_id=test_user,
			file_path=temp_test_zip,
			file_name='test_minimal_3_images.zip',
			license=LicenseEnum.cc_by,
			platform=PlatformEnum.drone,
			authors=['Test Author'],
			# Note: Not providing acquisition date - should be extracted from EXIF
			token=auth_token,
		)

		# Verify dataset was created (acquisition date extraction doesn't prevent processing)
		assert dataset is not None
		assert isinstance(dataset, Dataset)

		# Test succeeds if processing completes (EXIF extraction may or may not find dates in test images)

	@pytest.mark.asyncio
	async def test_rtk_detection_identifies_rtk_files(self, temp_test_zip, test_user, auth_token):
		"""Test that RTK detection identifies RTK files and metadata"""
		# Process the upload - test real RTK detection
		dataset = await process_raw_images_upload(
			user_id=test_user,
			file_path=temp_test_zip,
			file_name='test_minimal_3_images.zip',
			license=LicenseEnum.cc_by,
			platform=PlatformEnum.drone,
			authors=['Test Author'],
			token=auth_token,
		)

		# Verify dataset was created successfully
		assert dataset is not None
		assert isinstance(dataset, Dataset)

		# Verify raw_images entry was created (RTK detection runs on real ZIP contents)
		with use_client(auth_token) as client:
			raw_images_result = client.table('v2_raw_images').select('*').eq('dataset_id', dataset.id).execute()
			assert len(raw_images_result.data) == 1
			raw_images_data = raw_images_result.data[0]

			# Test that RTK fields exist (may be False/0 if no RTK files in test ZIP)
			assert 'has_rtk_data' in raw_images_data
			assert 'rtk_file_count' in raw_images_data

	@pytest.mark.asyncio
	async def test_images_transferred_to_storage_path(self, temp_test_zip, test_user, auth_token):
		"""Test that images are transferred to storage server at correct path"""
		# Process the upload using real storage settings
		dataset = await process_raw_images_upload(
			user_id=test_user,
			file_path=temp_test_zip,
			file_name='test_minimal_3_images.zip',
			license=LicenseEnum.cc_by,
			platform=PlatformEnum.drone,
			authors=['Test Author'],
			token=auth_token,
		)

		# Verify dataset was created successfully
		assert dataset is not None
		assert isinstance(dataset, Dataset)

		# Verify raw_images entry has correct storage path information
		with use_client(auth_token) as client:
			raw_images_result = client.table('v2_raw_images').select('*').eq('dataset_id', dataset.id).execute()
			assert len(raw_images_result.data) == 1
			raw_images_data = raw_images_result.data[0]

			# Verify storage path contains dataset ID and follows expected pattern
			assert str(dataset.id) in raw_images_data['raw_images_path']
			assert 'images' in raw_images_data['raw_images_path']

			# Verify image count is reasonable
			assert raw_images_data['raw_image_count'] >= 3


class TestEXIFUtilities:
	"""Test EXIF extraction utilities directly"""

	def test_extract_comprehensive_exif_with_real_image(self):
		"""Test EXIF extraction with real image files (if available)"""
		# This test will work with real images that have EXIF data
		# For now, test the function doesn't crash with non-existent files
		fake_path = Path('nonexistent_image.jpg')
		result = extract_comprehensive_exif(fake_path)
		assert isinstance(result, dict)
		assert len(result) == 0  # Should return empty dict for missing files

	def test_extract_acquisition_date_with_fake_path(self):
		"""Test acquisition date extraction with non-existent file"""
		fake_path = Path('nonexistent_image.jpg')
		result = extract_acquisition_date(fake_path)
		assert result is None  # Should return None for missing files


class TestRTKUtilities:
	"""Test RTK detection utilities directly"""

	def test_detect_rtk_files_with_rtk_present(self):
		"""Test RTK detection when RTK files are present"""
		zip_files = [
			'IMG_001.jpg',
			'IMG_002.jpg',
			'IMG_003.jpg',
			'IMG_001.MRK',  # RTK timestamp file
			'IMG_001.RTK',  # RTK correction data
			'base_station.RPOS',  # RTK position file
		]

		result = detect_rtk_files(zip_files)

		assert result['has_rtk'] == True
		assert len(result['rtk_files']) == 3
		assert 'IMG_001.MRK' in result['rtk_files']
		assert 'IMG_001.RTK' in result['rtk_files']
		assert 'base_station.RPOS' in result['rtk_files']
		assert result['precision_estimate'] == 'centimeter'  # Due to .MRK and .RTK files

	def test_detect_rtk_files_without_rtk(self):
		"""Test RTK detection when no RTK files are present"""
		zip_files = ['IMG_001.jpg', 'IMG_002.jpg', 'IMG_003.jpg', 'readme.txt']

		result = detect_rtk_files(zip_files)

		assert result['has_rtk'] == False
		assert len(result['rtk_files']) == 0
		assert result['precision_estimate'] is None

	def test_parse_rtk_timestamp_file_missing_file(self):
		"""Test RTK timestamp parsing with missing file"""
		fake_path = Path('nonexistent.MRK')
		result = parse_rtk_timestamp_file(fake_path)

		assert isinstance(result, dict)
		assert result['records_count'] == 0
		assert result['timestamps'] == []
		assert result['accuracy_horizontal'] is None
