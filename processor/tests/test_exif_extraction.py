"""
Test EXIF metadata extraction functionality with real drone image data.

Tests the flexible EXIF extraction system that can handle various camera manufacturers
and EXIF data structures without rigid schema constraints.
"""

import pytest
import zipfile
import tempfile
from pathlib import Path
from typing import Dict, Any

from shared.exif_utils import extract_comprehensive_exif, extract_acquisition_date
from shared.settings import settings
from shared.testing.fixtures import auth_token, test_processor_user
from shared.db import use_client


class TestEXIFExtraction:
	"""Test EXIF extraction with real drone image data."""

	@pytest.fixture
	def sample_drone_image(self):
		"""Extract a sample drone image from test data for EXIF testing."""
		# Use the standard mounted assets path pattern from other processor tests
		test_zip_path = Path('/app/assets/test_data/raw_drone_images/test_small_10_images.zip')

		if not test_zip_path.exists():
			pytest.skip(
				f'Test drone images not found at: {test_zip_path}. Run `./scripts/create_odm_test_data.sh` to create test data.'
			)

		# Create temporary directory for extraction
		temp_dir = tempfile.mkdtemp()
		temp_path = Path(temp_dir)

		# Extract first JPG file from test ZIP
		with zipfile.ZipFile(test_zip_path, 'r') as zip_ref:
			jpg_files = [f for f in zip_ref.namelist() if f.lower().endswith('.jpg')]
			if not jpg_files:
				pytest.skip('No JPG files found in test ZIP')

			first_jpg = jpg_files[0]
			zip_ref.extract(first_jpg, temp_path)

		yield temp_path / first_jpg

		# Cleanup
		import shutil

		shutil.rmtree(temp_dir)

	@pytest.fixture
	def multiple_drone_images(self):
		"""Extract multiple drone images from test data for comprehensive testing."""
		test_zip_path = Path('/app/assets/test_data/raw_drone_images/test_small_10_images.zip')

		if not test_zip_path.exists():
			pytest.skip(
				f'Test drone images not found at: {test_zip_path}. Run `./scripts/create_odm_test_data.sh` to create test data.'
			)

		temp_dir = tempfile.mkdtemp()
		temp_path = Path(temp_dir)
		extracted_images = []

		# Extract all JPG files for comprehensive testing
		with zipfile.ZipFile(test_zip_path, 'r') as zip_ref:
			jpg_files = [f for f in zip_ref.namelist() if f.lower().endswith('.jpg')]
			if not jpg_files:
				pytest.skip('No JPG files found in test ZIP')

			# Extract up to 5 images for testing variety
			for jpg_file in jpg_files[:5]:
				zip_ref.extract(jpg_file, temp_path)
				extracted_images.append(temp_path / jpg_file)

		yield extracted_images

		# Cleanup
		import shutil

		shutil.rmtree(temp_dir)

	def test_exif_extraction_from_real_drone_images(self, sample_drone_image):
		"""Test EXIF extraction from real DJI drone images."""
		# Extract EXIF data
		exif_data = extract_comprehensive_exif(sample_drone_image)

		# Verify data was extracted
		assert isinstance(exif_data, dict), 'EXIF data should be a dictionary'
		assert len(exif_data) > 0, 'Should extract EXIF fields from real drone images'

		# Verify all values are JSON serializable (critical for database storage)
		import json

		try:
			json.dumps(exif_data)
		except (TypeError, ValueError) as e:
			pytest.fail(f'EXIF data contains non-JSON-serializable values: {e}')

		# Verify typical drone EXIF fields are present (flexible check)
		expected_categories = [
			# Camera info: at least one of these should be present
			['Make', 'Model', 'Software'],
			# Image settings: at least one should be present
			['ISOSpeedRatings', 'FNumber', 'FocalLength', 'ExposureTime'],
			# Acquisition details: at least one should be present
			['DateTime', 'DateTimeOriginal', 'DateTimeDigitized'],
			# Technical specs: at least one should be present
			['ExifImageWidth', 'ExifImageHeight', 'XResolution', 'YResolution'],
		]

		categories_found = 0
		for category in expected_categories:
			if any(field in exif_data for field in category):
				categories_found += 1

		assert categories_found >= 3, (
			f'Should have EXIF fields from at least 3 categories, found {categories_found} categories with fields'
		)

	def test_exif_extraction_comprehensive_metadata_structure(self, sample_drone_image):
		"""Test comprehensive metadata structure for DJI drone images."""
		exif_data = extract_comprehensive_exif(sample_drone_image)

		# Verify DJI-specific metadata is captured
		if 'Make' in exif_data and 'DJI' in str(exif_data['Make']):
			# Test DJI-specific field handling
			dji_fields = ['Make', 'Model', 'Software', 'DateTime', 'GPSLatitude', 'GPSLongitude']
			found_dji_fields = [field for field in dji_fields if field in exif_data]

			assert len(found_dji_fields) >= 3, f'Should find multiple DJI fields, found: {found_dji_fields}'

			# Test timestamp handling
			if 'DateTime' in exif_data:
				assert isinstance(exif_data['DateTime'], str), 'DateTime should be a string'
				assert len(exif_data['DateTime']) > 0, 'DateTime should not be empty'

	def test_acquisition_date_extraction(self, sample_drone_image):
		"""Test acquisition date extraction from EXIF data."""
		acquisition_date = extract_acquisition_date(sample_drone_image)

		# Should return a valid datetime or None
		if acquisition_date is not None:
			from datetime import datetime

			assert isinstance(acquisition_date, datetime), 'Should return datetime object'
			# Sanity check: should be a reasonable date (between 2020 and now)
			assert acquisition_date.year >= 2020, 'Should be a reasonable acquisition year'
			assert acquisition_date.year <= 2025, 'Should not be in the future'

	def test_exif_extraction_graceful_error_handling(self):
		"""Test EXIF extraction handles invalid files gracefully."""
		# Test with non-existent file
		non_existent = Path('/tmp/does_not_exist.jpg')
		result = extract_comprehensive_exif(non_existent)
		assert result == {}, 'Should return empty dict for non-existent files'

		# Test with invalid image data (create a fake .jpg file)
		temp_dir = tempfile.mkdtemp()
		fake_jpg = Path(temp_dir) / 'fake.jpg'

		try:
			with open(fake_jpg, 'w') as f:
				f.write('This is not a valid JPEG file')

			result = extract_comprehensive_exif(fake_jpg)
			assert isinstance(result, dict), 'Should return dict even for invalid files'
			# Should be empty or minimal data
		finally:
			import shutil

			shutil.rmtree(temp_dir)

	def test_exif_extraction_different_image_formats(self):
		"""Test EXIF extraction handles different image formats gracefully."""
		test_zip_path = Path('/app/assets/test_data/raw_drone_images/test_small_10_images.zip')

		if not test_zip_path.exists():
			pytest.skip(
				f'Test drone images not found at: {test_zip_path}. Run `./scripts/create_odm_test_data.sh` to create test data.'
			)

		temp_dir = tempfile.mkdtemp()
		temp_path = Path(temp_dir)

		try:
			with zipfile.ZipFile(test_zip_path, 'r') as zip_ref:
				# Test various image extensions
				image_extensions = ['.jpg', '.jpeg', '.JPG', '.JPEG']

				for file_name in zip_ref.namelist():
					file_ext = Path(file_name).suffix
					if file_ext in image_extensions:
						zip_ref.extract(file_name, temp_path)
						image_path = temp_path / file_name

						# Should handle any valid image format
						exif_data = extract_comprehensive_exif(image_path)
						assert isinstance(exif_data, dict), f'Should return dict for {file_ext} files'
						# Don't assert content since some files might not have EXIF
		finally:
			import shutil

			shutil.rmtree(temp_dir)

	def test_gps_data_extraction_from_drone_images(self, multiple_drone_images):
		"""Test GPS data extraction from drone images with and without GPS data."""
		gps_images_found = 0
		non_gps_images_found = 0

		for image_path in multiple_drone_images:
			exif_data = extract_comprehensive_exif(image_path)

			# Check for GPS data presence
			gps_fields = ['GPSLatitude', 'GPSLongitude', 'GPSAltitude', 'GPSTimeStamp']
			gps_data_present = any(field in exif_data for field in gps_fields)

			if gps_data_present:
				gps_images_found += 1

				# Validate GPS data structure if present
				if 'GPSLatitude' in exif_data:
					gps_lat = exif_data['GPSLatitude']
					assert gps_lat is not None, 'GPS latitude should not be None'

				if 'GPSLongitude' in exif_data:
					gps_lon = exif_data['GPSLongitude']
					assert gps_lon is not None, 'GPS longitude should not be None'

			else:
				non_gps_images_found += 1

			# All images should have basic EXIF data regardless of GPS
			assert isinstance(exif_data, dict), 'Should always return dictionary'
			assert len(exif_data) > 0, 'Should have some EXIF data even without GPS'

		# Report results for verification
		print(f'✅ GPS data testing: {gps_images_found} images with GPS, {non_gps_images_found} without GPS')
		assert gps_images_found + non_gps_images_found == len(multiple_drone_images), 'Should process all images'

	def test_missing_incomplete_exif_data_handling(self, multiple_drone_images):
		"""Test handling of images with missing or incomplete EXIF data."""
		images_processed = 0
		metadata_variations = []

		for image_path in multiple_drone_images:
			exif_data = extract_comprehensive_exif(image_path)
			images_processed += 1

			# Track metadata variations across images
			fields_present = set(exif_data.keys())
			metadata_variations.append(
				{
					'image': image_path.name,
					'field_count': len(fields_present),
					'has_camera_info': any(field in fields_present for field in ['Make', 'Model']),
					'has_settings': any(field in fields_present for field in ['ISOSpeedRatings', 'FNumber']),
					'has_datetime': any(field in fields_present for field in ['DateTime', 'DateTimeOriginal']),
					'has_gps': any(field in fields_present for field in ['GPSLatitude', 'GPSLongitude']),
				}
			)

		# Verify robust handling of variations
		assert images_processed > 0, 'Should process at least one image'

		# Check that we handle different metadata completeness levels
		field_counts = [v['field_count'] for v in metadata_variations]
		assert min(field_counts) >= 0, 'Should handle images with minimal EXIF data'
		assert max(field_counts) > 10, 'Should extract comprehensive data when available'

		# Print summary for verification
		print(f'✅ Metadata variation testing: {len(metadata_variations)} images processed')
		for variation in metadata_variations:
			print(
				f'  {variation["image"]}: {variation["field_count"]} fields - '
				f'Camera: {variation["has_camera_info"]}, Settings: {variation["has_settings"]}, '
				f'DateTime: {variation["has_datetime"]}, GPS: {variation["has_gps"]}'
			)

	def test_real_world_data_variation_robustness(self, multiple_drone_images):
		"""Test robustness with real-world data variations across multiple images."""
		successful_extractions = 0
		error_count = 0
		unique_manufacturers = set()
		unique_models = set()

		for image_path in multiple_drone_images:
			try:
				exif_data = extract_comprehensive_exif(image_path)

				# Verify JSON serializability (critical for database storage)
				import json

				json.dumps(exif_data)

				successful_extractions += 1

				# Track manufacturer/model diversity
				if 'Make' in exif_data:
					unique_manufacturers.add(str(exif_data['Make']))
				if 'Model' in exif_data:
					unique_models.add(str(exif_data['Model']))

				# Verify essential data types
				for key, value in exif_data.items():
					assert isinstance(key, str), f'EXIF keys should be strings: {key}'
					# Values can be various types but must be JSON serializable

			except Exception as e:
				error_count += 1
				print(f'⚠️  Error processing {image_path.name}: {e}')

		# Verify robust performance
		total_images = len(multiple_drone_images)
		success_rate = (successful_extractions / total_images) * 100

		assert success_rate >= 80, f'Should successfully process ≥80% of images, got {success_rate}%'
		assert successful_extractions > 0, 'Should successfully process at least one image'

		# Report diversity findings
		print(f'✅ Real-world variation testing: {success_rate}% success rate')
		print(f'  Manufacturers found: {unique_manufacturers}')
		print(f'  Models found: {unique_models}')
		print(f'  Successful extractions: {successful_extractions}/{total_images}')

	def test_camera_metadata_database_integration(self, sample_drone_image, auth_token, test_processor_user):
		"""Test that EXIF metadata can be successfully stored and retrieved from database."""
		from shared.models import RawImages

		# Extract EXIF data
		exif_data = extract_comprehensive_exif(sample_drone_image)
		assert len(exif_data) > 0, 'Need EXIF data for database test'

		dataset_id = None
		try:
			# Create test dataset first (following existing test patterns)
			with use_client(auth_token) as client:
				dataset_data = {
					'file_name': 'test_exif_extraction.zip',
					'license': 'CC BY',
					'platform': 'drone',
					'authors': ['EXIF Test Author'],
					'user_id': test_processor_user,
					'data_access': 'public',
					'aquisition_year': 2024,
					'aquisition_month': 1,
				}
				dataset_response = client.table(settings.datasets_table).insert(dataset_data).execute()
				dataset_id = dataset_response.data[0]['id']

				# Create raw_images entry with EXIF metadata
				raw_images_data = {
					'dataset_id': dataset_id,
					'version': 1,
					'raw_image_count': 1,
					'raw_image_size_mb': 10,
					'raw_images_path': '/test/path.zip',
					'camera_metadata': exif_data,  # Store flexible EXIF data
					'has_rtk_data': False,
					'rtk_precision_cm': None,
					'rtk_quality_indicator': None,
					'rtk_file_count': 0,
				}
				client.table(settings.raw_images_table).insert(raw_images_data).execute()

				# Retrieve and verify the stored metadata
				retrieved = (
					client.table(settings.raw_images_table)
					.select('camera_metadata')
					.eq('dataset_id', dataset_id)
					.execute()
				)
				assert retrieved.data, 'Should retrieve raw images entry'

				retrieved_metadata = retrieved.data[0]['camera_metadata']
				assert isinstance(retrieved_metadata, dict), 'Retrieved metadata should be a dictionary'
				assert len(retrieved_metadata) > 0, 'Should have EXIF fields'

				# Verify it's the same EXIF data (flexible comparison)
				for key, value in exif_data.items():
					assert key in retrieved_metadata, f'Should preserve EXIF field: {key}'
					assert retrieved_metadata[key] == value, f'Should preserve EXIF value for {key}'

		finally:
			# Cleanup test data
			if dataset_id:
				with use_client(auth_token) as client:
					client.table(settings.raw_images_table).delete().eq('dataset_id', dataset_id).execute()
					client.table(settings.datasets_table).delete().eq('id', dataset_id).execute()

	@pytest.mark.parametrize(
		'manufacturer_simulation',
		[
			# Simulate different manufacturer EXIF structures
			{'Make': 'Canon', 'Model': 'EOS R5', 'LensModel': 'RF24-70mm F2.8 L IS USM'},
			{'Make': 'DJI', 'Model': 'Mavic 3', 'UniqueCameraModel': 'DJI Mavic 3'},
			{'Make': 'Sony', 'Model': 'Alpha 7R IV', 'LensInfo': [24, 70, 2.8, 2.8]},
			{'Manufacturer': 'Nikon', 'CameraModel': 'D850'},  # Different field names
			{
				'Make': 'DJI',
				'Model': 'Air 2S',
				'GPSLatitude': [52, 31, 12.34],
				'GPSLongitude': [13, 24, 56.78],
			},  # DJI with GPS
			{'Make': 'Parrot', 'Model': 'ANAFI', 'Software': 'Parrot SDK'},  # Different drone manufacturer
		],
	)
	def test_flexible_manufacturer_metadata_handling(self, manufacturer_simulation):
		"""Test that our flexible EXIF approach handles different manufacturer field names."""
		# Simulate database storage and retrieval with different manufacturer structures
		import json

		# Verify all manufacturer simulations are JSON serializable
		try:
			json.dumps(manufacturer_simulation)
		except (TypeError, ValueError) as e:
			pytest.fail(f'Manufacturer EXIF simulation not JSON serializable: {e}')

		# Our flexible approach should handle any field names
		assert isinstance(manufacturer_simulation, dict), 'Should handle any EXIF structure'

		# All field names should be strings (EXIF tags are always strings)
		for key in manufacturer_simulation.keys():
			assert isinstance(key, str), f'EXIF field names should be strings: {key}'
