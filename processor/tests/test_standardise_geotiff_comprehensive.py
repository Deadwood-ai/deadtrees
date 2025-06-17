"""
Comprehensive tests for GeoTIFF standardization using synthetic test data with fixtures
"""

import pytest
import rasterio
import numpy as np
from pathlib import Path
from processor.src.geotiff.standardise_geotiff import standardise_geotiff, find_nodata_value, verify_geotiff

# Import the test data generator utilities
import sys

sys.path.append(str(Path(__file__).parent))

from utils.test_data_generator import (
	GeoTIFFTestDataGenerator,
	TestDatasetConfig,
	NoDataType,
	ValueRangeType,
	BlockLayout,
	TEST_CONFIGURATIONS,
)


@pytest.fixture
def test_data_generator(tmp_path):
	"""Create a test data generator with a temporary directory"""
	generator = GeoTIFFTestDataGenerator(tmp_path)
	yield generator
	# Cleanup happens automatically with tmp_path


@pytest.fixture
def problematic_geotiff(test_data_generator):
	"""Generate a problematic dataset similar to your real-world issues"""
	config = TestDatasetConfig(
		name='problematic_scenario',
		dtype='float32',
		bands=3,
		nodata_type=NoDataType.EDGE_DETECTED,
		value_range=ValueRangeType.EXTREME_FLOAT,
		nodata_percentage=0.4,
	)
	return test_data_generator.generate_dataset(config)


@pytest.fixture(params=TEST_CONFIGURATIONS)
def all_test_configurations(request, test_data_generator):
	"""Parameterized fixture that generates all test configurations"""
	config = request.param
	input_path = test_data_generator.generate_dataset(config)
	return config, input_path


@pytest.fixture
def ten_band_negative_nodata_geotiff(test_data_generator):
	"""Generate the exact 10-band scenario from 3798_ortho_blue.tif"""
	config = TestDatasetConfig(
		name='real_world_10bands_negative_nodata',
		dtype='float32',
		bands=10,
		nodata_type=NoDataType.NEGATIVE_NUMERIC,
		nodata_value=-32767.0,
		value_range=ValueRangeType.ALREADY_SCALED,  # 0-255 range
		nodata_percentage=0.6,  # Significant nodata areas
	)
	return test_data_generator.generate_dataset(config)


@pytest.fixture
def nan_already_scaled_geotiff(test_data_generator):
	"""Generate the exact NaN + already scaled scenario from 3885_ortho_black.tif"""
	config = TestDatasetConfig(
		name='real_world_nan_already_scaled',
		dtype='float32',
		bands=3,
		nodata_type=NoDataType.NAN,
		value_range=ValueRangeType.ALREADY_SCALED,  # Already 0-255
		nodata_percentage=0.3,
	)
	return test_data_generator.generate_dataset(config)


@pytest.fixture
def uint16_eight_bands_alpha_geotiff(test_data_generator):
	"""Generate the exact 8-band uint16 with alpha scenario from 3850_ortho.tif"""
	config = TestDatasetConfig(
		name='real_world_8bands_uint16_alpha',
		dtype='uint16',
		bands=8,
		has_alpha=True,
		value_range=ValueRangeType.UINT16_RANGE,
		nodata_value=0,
		nodata_percentage=0.2,
	)
	return test_data_generator.generate_dataset(config)


@pytest.fixture
def grayscale_large_negative_nodata_geotiff(test_data_generator):
	"""Generate the exact grayscale + large negative nodata scenario from 3332_ortho.tif"""
	config = TestDatasetConfig(
		name='real_world_grayscale_large_negative',
		dtype='float32',
		bands=1,  # Grayscale
		nodata_type=NoDataType.NEGATIVE_NUMERIC,
		nodata_value=-10000.0,
		value_range=ValueRangeType.ALREADY_SCALED,
		nodata_percentage=0.5,
	)
	return test_data_generator.generate_dataset(config)


class TestStandardiseGeoTIFF:
	"""Comprehensive test suite for GeoTIFF standardization"""

	@pytest.mark.parametrize('config', TEST_CONFIGURATIONS)
	def test_all_configurations_standardization(self, config, test_data_generator, tmp_path):
		"""Test standardization with ALL enhanced configurations"""
		# Generate test dataset
		input_path = test_data_generator.generate_dataset(config)
		output_path = tmp_path / f'{config.name}_standardized.tif'

		# Run standardization
		success = standardise_geotiff(str(input_path), str(output_path))

		# Should always succeed (or we have a bug to fix)
		assert success, f'Standardization failed for {config.name}'
		assert output_path.exists(), f'Output file not created for {config.name}'

		# Verify output file integrity
		assert verify_geotiff(str(output_path)), f'Output verification failed for {config.name}'

		# Check output characteristics
		with rasterio.open(output_path) as dst:
			# Should always be uint8
			assert dst.profile['dtype'] == 'uint8', f'Output not uint8 for {config.name}'

			# Should have appropriate number of bands
			assert dst.count <= 4, f'Too many bands in output for {config.name}'

			# Should have proper compression (case-insensitive check)
			compression = dst.profile.get('compress', '').upper()
			assert compression == 'DEFLATE', f'Wrong compression for {config.name}: got {compression}'

			# Check for transparency handling when nodata is present
			if config.nodata_type != NoDataType.NONE and dst.count == 4:
				alpha_band = dst.read(4)
				assert np.any(alpha_band == 0), f'No transparency in alpha band for {config.name}'

	def test_real_world_ten_band_scenario(self, ten_band_negative_nodata_geotiff, tmp_path):
		"""Test the exact 10-band scenario from 3798_ortho_blue.tif"""
		output_path = tmp_path / 'ten_band_standardized.tif'

		success = standardise_geotiff(str(ten_band_negative_nodata_geotiff), str(output_path))
		assert success, 'Should handle 10-band float32 with -32767 nodata'

		with rasterio.open(output_path) as dst:
			assert dst.profile['dtype'] == 'uint8'
			assert dst.count == 3 or dst.count == 4  # Should be reduced to RGB(+A)

			# Check that nodata areas are properly handled with transparency
			if dst.count == 4:  # Has alpha channel
				alpha_band = dst.read(4)
				# Should have transparent areas where nodata was
				assert np.any(alpha_band == 0), 'Should have transparent areas from nodata'
				# Should also have opaque areas where data was
				assert np.any(alpha_band == 255), 'Should have opaque areas where data exists'

	def test_real_world_nan_already_scaled_scenario(self, nan_already_scaled_geotiff, tmp_path):
		"""Test the exact NaN + already scaled scenario from 3885_ortho_black.tif"""
		output_path = tmp_path / 'nan_scaled_standardized.tif'

		success = standardise_geotiff(str(nan_already_scaled_geotiff), str(output_path))
		assert success, 'Should handle float32 NaN with already-scaled data'

		with rasterio.open(output_path) as dst:
			assert dst.profile['dtype'] == 'uint8'
			# Should maintain brightness since input was already 0-255
			data = dst.read()
			rgb_data = data[:3]
			valid_data = rgb_data[rgb_data > 0]
			if len(valid_data) > 0:
				mean_brightness = np.mean(valid_data)
				assert mean_brightness > 50, f'Should maintain reasonable brightness, got {mean_brightness}'

	def test_real_world_uint16_eight_bands_scenario(self, uint16_eight_bands_alpha_geotiff, tmp_path):
		"""Test the exact 8-band uint16 with alpha scenario from 3850_ortho.tif"""
		output_path = tmp_path / 'uint16_eight_bands_standardized.tif'

		success = standardise_geotiff(str(uint16_eight_bands_alpha_geotiff), str(output_path))
		assert success, 'Should handle uint16 8-band with alpha'

		with rasterio.open(output_path) as dst:
			assert dst.profile['dtype'] == 'uint8'
			# Should reduce to RGB + preserve alpha if needed
			assert dst.count <= 4

	def test_real_world_grayscale_large_negative_scenario(self, grayscale_large_negative_nodata_geotiff, tmp_path):
		"""Test the exact grayscale + large negative nodata scenario from 3332_ortho.tif"""
		output_path = tmp_path / 'grayscale_negative_standardized.tif'

		success = standardise_geotiff(str(grayscale_large_negative_nodata_geotiff), str(output_path))
		assert success, 'Should handle grayscale float32 with -10000 nodata'

		with rasterio.open(output_path) as dst:
			assert dst.profile['dtype'] == 'uint8'
			# For grayscale input, may stay as grayscale + alpha or expand to RGB
			# depending on the standardization function behavior
			assert dst.count >= 1, 'Should have at least one band'

	def test_problematic_data_standardization(self, problematic_geotiff, tmp_path):
		"""Test the exact problematic scenario from your real data"""
		output_path = tmp_path / 'problematic_standardized.tif'

		success = standardise_geotiff(str(problematic_geotiff), str(output_path))
		assert success, 'Standardization should succeed even with problematic data'
		assert output_path.exists(), 'Output file should be created'

		# Verify output characteristics
		with rasterio.open(output_path) as dst:
			assert dst.profile['dtype'] == 'uint8', 'Output should be uint8'
			assert dst.count >= 1, 'Should have at least one band'

			# Check that output is not all dark (your main issue)
			data = dst.read()
			rgb_data = data[:3] if dst.count >= 3 else data
			valid_data = rgb_data[rgb_data > 0]

			if len(valid_data) > 0:
				mean_brightness = np.mean(valid_data)
				assert mean_brightness > 20, f'Output too dark: mean brightness = {mean_brightness}'

	def test_nodata_detection_comprehensive(self, test_data_generator):
		"""Test nodata detection for all NoDataType scenarios"""
		test_cases = [
			('explicit_numeric', NoDataType.EXPLICIT_NUMERIC, 0),
			('negative_numeric', NoDataType.NEGATIVE_NUMERIC, -32767),
			('large_negative', NoDataType.NEGATIVE_NUMERIC, -10000),
			('nan_nodata', NoDataType.NAN, None),
			('edge_detected', NoDataType.EDGE_DETECTED, None),
			('mixed_nodata', NoDataType.MIXED, None),
			('no_nodata', NoDataType.NONE, None),
		]

		for test_name, nodata_type, custom_nodata in test_cases:
			config = TestDatasetConfig(
				name=test_name,
				dtype='float32',
				bands=3,
				nodata_type=nodata_type,
				value_range=ValueRangeType.FULL_UINT8,
				nodata_percentage=0.3 if nodata_type != NoDataType.NONE else 0.0,
				nodata_value=custom_nodata,
			)

			input_path = test_data_generator.generate_dataset(config)

			with rasterio.open(input_path) as src:
				detected_nodata = find_nodata_value(src, src.count)

				if nodata_type == NoDataType.NONE:
					pass  # Can be None or various values
				elif nodata_type == NoDataType.NAN:
					assert detected_nodata == 'nan', f'Should detect NaN for {test_name}'
				elif nodata_type in [NoDataType.EXPLICIT_NUMERIC, NoDataType.NEGATIVE_NUMERIC]:
					assert detected_nodata is not None and detected_nodata != 'nan', (
						f'Should detect numeric nodata for {test_name}'
					)
					if custom_nodata is not None:
						assert detected_nodata == custom_nodata, (
							f'Should detect custom nodata {custom_nodata} for {test_name}'
						)

	def test_value_range_scaling_comprehensive(self, test_data_generator, tmp_path):
		"""Test scaling for different value ranges"""
		value_range_cases = [
			('compressed', ValueRangeType.COMPRESSED, 70),
			('uint16_range', ValueRangeType.UINT16_RANGE, 65535),
			('extreme_float', ValueRangeType.EXTREME_FLOAT, 10000),
			('already_scaled', ValueRangeType.ALREADY_SCALED, 255),
		]

		for range_name, value_range, expected_max in value_range_cases:
			config = TestDatasetConfig(
				name=f'scaling_test_{range_name}',
				dtype='float32' if value_range != ValueRangeType.UINT16_RANGE else 'uint16',
				bands=3,
				nodata_type=NoDataType.NONE,
				value_range=value_range,
			)

			input_path = test_data_generator.generate_dataset(config)
			output_path = tmp_path / f'scaled_{range_name}.tif'

			# Check input range
			with rasterio.open(input_path) as src:
				input_data = src.read()
				input_max = np.max(input_data)
				# Verify our test data has expected range
				assert input_max <= expected_max * 1.1, f'Input max {input_max} should be near {expected_max}'

			# Standardize
			success = standardise_geotiff(str(input_path), str(output_path))
			assert success, f'Standardization should succeed for {range_name}'

			# Check output scaling
			with rasterio.open(output_path) as dst:
				output_data = dst.read()
				output_max = np.max(output_data)
				output_min = np.min(output_data)

				# Should be in uint8 range
				assert 0 <= output_min <= output_max <= 255, f'Output should be in uint8 range for {range_name}'

				# Should use reasonable portion of the range (unless input was uniform)
				if value_range != ValueRangeType.UNIFORM:
					assert output_max >= 100, f'Output should use good range for {range_name}: max={output_max}'

	def test_band_reduction_scenarios(self, test_data_generator, tmp_path):
		"""Test that high band counts are properly reduced to RGB+Alpha"""
		band_cases = [
			('single_band', 1),
			('rgb', 3),
			('rgba', 4),
			('multispectral_5', 5),
			('multispectral_8', 8),
			('hyperspectral_10', 10),
		]

		for band_name, num_bands in band_cases:
			config = TestDatasetConfig(
				name=f'band_test_{band_name}',
				dtype='uint16',
				bands=num_bands,
				nodata_type=NoDataType.NONE,
				value_range=ValueRangeType.UINT16_RANGE,
			)

			input_path = test_data_generator.generate_dataset(config)
			output_path = tmp_path / f'bands_{band_name}.tif'

			success = standardise_geotiff(str(input_path), str(output_path))
			assert success, f'Should handle {num_bands} bands'

			with rasterio.open(output_path) as dst:
				# High band count should be reduced
				if num_bands > 4:
					assert dst.count <= 4, f'Should reduce {num_bands} bands to ≤4'

				# Single band should be preserved or expanded based on implementation
				if num_bands == 1:
					assert dst.count >= 1, 'Should handle single band'

	def test_compression_and_layout_handling(self, test_data_generator, tmp_path):
		"""Test different compression and block layout scenarios"""
		layout_cases = [
			('tiled_lzw', BlockLayout.TILED, 'LZW'),
			('strip_deflate', BlockLayout.STRIP, 'DEFLATE'),
			('single_strip_none', BlockLayout.SINGLE_STRIP, None),
		]

		for layout_name, block_layout, compression in layout_cases:
			config = TestDatasetConfig(
				name=f'layout_test_{layout_name}',
				dtype='uint8',
				bands=3,
				nodata_type=NoDataType.NONE,
				compress=compression,
				block_layout=block_layout,
			)

			input_path = test_data_generator.generate_dataset(config)
			output_path = tmp_path / f'layout_{layout_name}.tif'

			success = standardise_geotiff(str(input_path), str(output_path))
			assert success, f'Should handle {layout_name} layout'

			# Output should always use standard format
			with rasterio.open(output_path) as dst:
				compression = dst.profile.get('compress', '').upper()
				assert compression == 'DEFLATE', f'Output should use DEFLATE compression, got {compression}'
				assert dst.profile.get('tiled', False), 'Output should be tiled'

	def test_integration_with_processing_pipeline(self, problematic_geotiff, tmp_path):
		"""Test integration aspects like file cleanup and error handling"""
		output_path = tmp_path / 'integration_test.tif'

		# Should handle the standardization
		success = standardise_geotiff(str(problematic_geotiff), str(output_path))
		assert success, 'Integration test should succeed'

		# Output should be valid
		assert verify_geotiff(str(output_path)), 'Output should pass verification'

		# Should be ready for further processing (no temp files left behind)
		temp_files = list(tmp_path.glob('*.temp.*'))
		assert len(temp_files) == 0, f'Should clean up temp files, found: {temp_files}'

		# Output should have standardized properties
		with rasterio.open(output_path) as dst:
			profile = dst.profile
			assert profile['dtype'] == 'uint8'
			assert profile.get('tiled', False)
			assert profile.get('compress', '').upper() == 'DEFLATE'

	def test_edge_cases_and_error_scenarios(self, test_data_generator, tmp_path):
		"""Test edge cases that might cause failures"""
		edge_cases = [
			# All nodata
			TestDatasetConfig(
				name='all_nodata_test',
				dtype='float32',
				bands=3,
				nodata_type=NoDataType.EXPLICIT_NUMERIC,
				nodata_percentage=1.0,
			),
			# Uniform values (no variance)
			TestDatasetConfig(
				name='uniform_test',
				dtype='uint8',
				bands=3,
				value_range=ValueRangeType.UNIFORM,
				nodata_type=NoDataType.NONE,
			),
			# Extreme values
			TestDatasetConfig(
				name='extreme_test',
				dtype='float32',
				bands=3,
				value_range=ValueRangeType.EXTREME_FLOAT,
				nodata_type=NoDataType.NONE,
			),
		]

		for config in edge_cases:
			input_path = test_data_generator.generate_dataset(config)
			output_path = tmp_path / f'{config.name}_output.tif'

			# Should either succeed or fail gracefully
			try:
				success = standardise_geotiff(str(input_path), str(output_path))
				if success:
					assert output_path.exists(), f'If success=True, output should exist for {config.name}'
					assert verify_geotiff(str(output_path)), f'Output should be valid for {config.name}'
			except Exception as e:
				pytest.fail(f'Should not raise unhandled exception for {config.name}: {e}')
