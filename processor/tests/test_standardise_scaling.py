"""
Test that percentile-based scaling in standardise_geotiff produces visible (non-black) output
for high bit-depth satellite imagery (e.g., WorldView uint16).

Fixture: assets/test_data/worldview_uint16_crop.tif
- 128x128 crop from real WorldView dataset 8019 (4-band RGBNIR, uint16, EPSG:25832)
- Typical pixel values: mean ~35, p98 ~150
- Injected outlier pixels at 3000 (simulating the real full-image outlier distribution)

The old min/max scaling compressed useful data into 0-24 range (black).
The new percentile scaling should spread it across a much wider range.
"""

import pytest
import rasterio
import numpy as np
from types import SimpleNamespace
from pathlib import Path

from processor.src.geotiff import standardise_geotiff as standardise_module
from processor.src.geotiff.standardise_geotiff import (
	_apply_final_transformations,
	_handle_bit_depth_conversion,
	_is_plausible_detected_nodata,
	standardise_geotiff,
)


pytestmark = pytest.mark.unit

TEST_DATA_DIR = Path(__file__).parent.parent.parent / 'assets' / 'test_data'
WORLDVIEW_FIXTURE = TEST_DATA_DIR / 'worldview_uint16_crop.tif'


@pytest.fixture
def worldview_input():
	"""Path to the WorldView uint16 test fixture."""
	if not WORLDVIEW_FIXTURE.exists():
		pytest.skip(
			f'WorldView scaling fixture not found at {WORLDVIEW_FIXTURE}. '
			'Run `make download-processor-assets` before running scaling regression tests.'
		)
	return str(WORLDVIEW_FIXTURE)


@pytest.fixture
def output_path(tmp_path):
	"""Temporary output path for the converted file."""
	return str(tmp_path / 'converted.tif')


def test_uint16_scaling_produces_visible_output(worldview_input, output_path):
	"""
	Core regression test: uint16 satellite imagery must not produce black output.

	Before the fix (raw min/max scaling), a WorldView image with outlier pixels
	at ~3000 would compress the useful data (mean ~35) into range 0-24 — effectively black.

	After the fix (percentile-based scaling), the same data should produce output
	with mean pixel values well above 50, demonstrating proper contrast stretch.
	"""
	result_path, nodata = _handle_bit_depth_conversion(
		input_path=worldview_input,
		output_path=output_path,
		src_dtype='uint16',
		has_alpha=False,
		compression='DEFLATE',
		token='test-token',
		dataset_id=8019,
		user_id='test-user',
	)

	assert result_path is not None, 'Conversion failed — returned None'

	with rasterio.open(result_path) as src:
		# Output must be uint8
		assert src.dtypes[0] == 'uint8', f'Expected uint8 output, got {src.dtypes[0]}'

		# Should have 3 bands (RGB, dropping the NIR band)
		assert src.count == 3, f'Expected 3 bands, got {src.count}'

		data = src.read()

		for band_idx in range(3):
			band = data[band_idx]
			valid = band[band > 0]

			if len(valid) == 0:
				pytest.fail(f'Band {band_idx + 1} has no valid (non-zero) pixels')

			band_mean = float(np.mean(valid))
			band_max = float(np.max(valid))

			# THE KEY ASSERTION: mean must be well above the "black" threshold.
			# With old min/max scaling: mean was ~3-5 (black)
			# With percentile scaling: mean should be ~50+ (visible)
			assert band_mean > 30, (
				f'Band {band_idx + 1} mean={band_mean:.1f} is too dark — '
				f'scaling is likely still using raw min/max instead of percentiles'
			)

			# Max should use a good portion of the 0-255 range
			assert band_max > 100, (
				f'Band {band_idx + 1} max={band_max:.1f} — '
				f'output does not use enough of the uint8 range'
			)


def test_uint16_scaling_clips_outliers(worldview_input, output_path):
	"""
	Outlier pixels above the 98th percentile should be clipped to 255 (white),
	not warp the entire histogram.
	"""
	result_path, _ = _handle_bit_depth_conversion(
		input_path=worldview_input,
		output_path=output_path,
		src_dtype='uint16',
		has_alpha=False,
		compression='DEFLATE',
		token='test-token',
		dataset_id=8019,
		user_id='test-user',
	)

	assert result_path is not None

	with rasterio.open(result_path) as src:
		data = src.read()

		for band_idx in range(3):
			band = data[band_idx]
			# The injected outlier pixels (value 3000 in uint16) should be clipped to 255
			num_at_255 = np.sum(band == 255)
			assert num_at_255 > 0, (
				f'Band {band_idx + 1}: no pixels at 255 — '
				f'outlier clipping is not working'
			)


def test_uint8_input_skips_scaling(tmp_path):
	"""
	uint8 images should pass through without any scaling applied.
	This ensures the fix doesn't break existing drone imagery.
	"""
	# Create a simple uint8 test image
	input_path = str(tmp_path / 'uint8_input.tif')
	output_path = str(tmp_path / 'uint8_output.tif')

	profile = {
		'driver': 'GTiff',
		'dtype': 'uint8',
		'width': 64,
		'height': 64,
		'count': 3,
		'crs': 'EPSG:4326',
		'transform': rasterio.transform.from_bounds(8.0, 48.0, 8.01, 48.01, 64, 64),
	}
	data = np.random.randint(50, 200, (3, 64, 64), dtype=np.uint8)

	with rasterio.open(input_path, 'w', **profile) as dst:
		dst.write(data)

	result_path, nodata = _handle_bit_depth_conversion(
		input_path=input_path,
		output_path=output_path,
		src_dtype='uint8',
		has_alpha=False,
		compression='DEFLATE',
		token='test-token',
	)

	# For uint8, the function returns the original input path unchanged
	assert result_path == input_path, 'uint8 input should not be converted'


def test_uint16_high_nodata_survives_byte_conversion_as_alpha(tmp_path):
	"""
	Regression for AWI dataset 10388.

	The source has 65535 background pixels but no explicit nodata metadata.
	When converting to Byte, 65535 must be repainted to byte nodata before
	the final alpha step. Otherwise the public COG renders large white blocks.
	"""
	input_path = tmp_path / 'uint16_65535_background.tif'
	output_path = tmp_path / 'standardized.tif'
	width = 96
	height = 96

	data = np.zeros((4, height, width), dtype=np.uint16)
	y, x = np.mgrid[0:height, 0:width]
	data[0] = 800 + x * 8
	data[1] = 1200 + y * 8
	data[2] = 1000 + (x + y) * 4
	data[3] = 2500

	# Background/no-data collar and an interior hole like a clipped orthomosaic.
	nodata_mask = np.zeros((height, width), dtype=bool)
	nodata_mask[:12, :] = True
	nodata_mask[-12:, :] = True
	nodata_mask[:, :10] = True
	nodata_mask[:, -10:] = True
	nodata_mask[40:55, 42:58] = True
	data[:, nodata_mask] = 65535

	profile = {
		'driver': 'GTiff',
		'dtype': 'uint16',
		'width': width,
		'height': height,
		'count': 4,
		'crs': 'EPSG:32608',
		'transform': rasterio.transform.from_origin(442287.0, 7390649.0, 0.03, 0.03),
		'interleave': 'pixel',
	}
	with rasterio.open(input_path, 'w', **profile) as dst:
		dst.write(data)
		dst.colorinterp = (
			rasterio.enums.ColorInterp.red,
			rasterio.enums.ColorInterp.green,
			rasterio.enums.ColorInterp.blue,
			rasterio.enums.ColorInterp.gray,
		)

	assert standardise_geotiff(str(input_path), str(output_path), token='test-token', dataset_id=10388)

	with rasterio.open(output_path) as dst:
		assert dst.dtypes[0] == 'uint8'
		assert dst.count == 4
		alpha = dst.read(4)
		rgb = dst.read([1, 2, 3])

		assert np.all(alpha[nodata_mask] == 0)
		assert np.all(alpha[~nodata_mask] == 255)
		assert np.all(rgb[:, nodata_mask] == 0)
		assert np.max(rgb[:, ~nodata_mask]) > 100


def test_single_band_high_nodata_gets_alpha_without_rgb_assumption(tmp_path):
	input_path = tmp_path / 'single_band_65535_background.tif'
	output_path = tmp_path / 'single_band_standardized.tif'
	width = 64
	height = 64
	y, x = np.mgrid[0:height, 0:width]
	data = (1000 + x * 10 + y * 5).astype(np.uint16)
	nodata_mask = np.zeros((height, width), dtype=bool)
	nodata_mask[:10, :] = True
	nodata_mask[28:40, 30:46] = True
	data[nodata_mask] = 65535

	profile = {
		'driver': 'GTiff',
		'dtype': 'uint16',
		'width': width,
		'height': height,
		'count': 1,
		'crs': 'EPSG:32608',
		'transform': rasterio.transform.from_origin(442287.0, 7390649.0, 1.0, 1.0),
	}
	with rasterio.open(input_path, 'w', **profile) as dst:
		dst.write(data, 1)
		dst.colorinterp = (rasterio.enums.ColorInterp.gray,)

	assert standardise_geotiff(str(input_path), str(output_path), token='test-token', dataset_id=10388)

	with rasterio.open(output_path) as dst:
		assert dst.dtypes[0] == 'uint8'
		assert dst.count == 4
		assert dst.colorinterp[3] == rasterio.enums.ColorInterp.alpha
		alpha = dst.read(4)
		gray = dst.read(1)

		assert np.all(alpha[nodata_mask] == 0)
		assert np.all(alpha[~nodata_mask] == 255)
		assert np.all(gray[nodata_mask] == 0)
		assert np.max(gray[~nodata_mask]) > 100


def test_float_detected_sentinel_nodata_gets_alpha(tmp_path):
	input_path = tmp_path / 'float_sentinel_background.tif'
	output_path = tmp_path / 'float_standardized.tif'
	width = 72
	height = 72
	y, x = np.mgrid[0:height, 0:width]
	data = np.zeros((3, height, width), dtype=np.float32)
	data[0] = 20.0 + x * 0.8
	data[1] = 30.0 + y * 0.6
	data[2] = 25.0 + (x + y) * 0.4

	nodata_mask = np.zeros((height, width), dtype=bool)
	nodata_mask[:12, :] = True
	nodata_mask[-10:, :] = True
	nodata_mask[:, :8] = True
	nodata_mask[30:44, 34:50] = True
	data[:, nodata_mask] = -9999.0

	profile = {
		'driver': 'GTiff',
		'dtype': 'float32',
		'width': width,
		'height': height,
		'count': 3,
		'crs': 'EPSG:32608',
		'transform': rasterio.transform.from_origin(442287.0, 7390649.0, 1.0, 1.0),
	}
	with rasterio.open(input_path, 'w', **profile) as dst:
		dst.write(data)
		dst.colorinterp = (
			rasterio.enums.ColorInterp.red,
			rasterio.enums.ColorInterp.green,
			rasterio.enums.ColorInterp.blue,
		)

	assert standardise_geotiff(str(input_path), str(output_path), token='test-token', dataset_id=10388)

	with rasterio.open(output_path) as dst:
		assert dst.dtypes[0] == 'uint8'
		assert dst.count == 4
		alpha = dst.read(4)
		rgb = dst.read([1, 2, 3])

		assert np.all(alpha[nodata_mask] == 0)
		assert np.all(alpha[~nodata_mask] == 255)
		assert np.all(rgb[:, nodata_mask] == 0)
		assert np.max(rgb[:, ~nodata_mask]) > 100


@pytest.mark.parametrize(
	'value,dtype,expected',
	[
		(0, 'uint16', True),
		(65535, 'uint16', True),
		(65534, 'uint16', True),
		(-32768, 'int16', True),
		(-32767, 'int16', True),
		(-9999, 'int16', True),
		(1234, 'uint16', False),
		(42, 'int16', False),
		(-12.5, 'int16', False),
	],
)
def test_detected_integer_nodata_plausibility(value, dtype, expected):
	assert _is_plausible_detected_nodata(value, dtype) is expected


def test_uint16_zero_detected_nodata_gets_alpha(tmp_path):
	input_path = tmp_path / 'uint16_zero_background.tif'
	output_path = tmp_path / 'zero_background_standardized.tif'
	width = 64
	height = 64
	y, x = np.mgrid[0:height, 0:width]
	data = np.zeros((3, height, width), dtype=np.uint16)
	data[0] = 700 + x * 6
	data[1] = 900 + y * 6
	data[2] = 800 + (x + y) * 3

	nodata_mask = np.zeros((height, width), dtype=bool)
	nodata_mask[:10, :] = True
	nodata_mask[:, :8] = True
	nodata_mask[30:42, 28:44] = True
	data[:, nodata_mask] = 0

	profile = {
		'driver': 'GTiff',
		'dtype': 'uint16',
		'width': width,
		'height': height,
		'count': 3,
		'crs': 'EPSG:32608',
		'transform': rasterio.transform.from_origin(442287.0, 7390649.0, 1.0, 1.0),
	}
	with rasterio.open(input_path, 'w', **profile) as dst:
		dst.write(data)
		dst.colorinterp = (
			rasterio.enums.ColorInterp.red,
			rasterio.enums.ColorInterp.green,
			rasterio.enums.ColorInterp.blue,
		)

	assert standardise_geotiff(str(input_path), str(output_path), token='test-token', dataset_id=10388)

	with rasterio.open(output_path) as dst:
		assert dst.count == 4
		alpha = dst.read(4)
		assert np.all(alpha[nodata_mask] == 0)
		assert np.all(alpha[~nodata_mask] == 255)


def test_source_alpha_pixels_are_excluded_from_scaling(tmp_path):
	input_path = tmp_path / 'uint16_rgba_transparent_outliers.tif'
	output_path = tmp_path / 'rgba_standardized.tif'
	width = 80
	height = 80
	y, x = np.mgrid[0:height, 0:width]
	data = np.zeros((4, height, width), dtype=np.uint16)
	data[0] = 900 + x * 5
	data[1] = 1000 + y * 5
	data[2] = 1100 + (x + y) * 2
	data[3] = 65535

	transparent_mask = np.zeros((height, width), dtype=bool)
	transparent_mask[20:60, 20:60] = True
	data[:3, transparent_mask] = 65535
	data[3, transparent_mask] = 0

	profile = {
		'driver': 'GTiff',
		'dtype': 'uint16',
		'width': width,
		'height': height,
		'count': 4,
		'crs': 'EPSG:32608',
		'transform': rasterio.transform.from_origin(442287.0, 7390649.0, 1.0, 1.0),
	}
	with rasterio.open(input_path, 'w', **profile) as dst:
		dst.write(data)
		dst.colorinterp = (
			rasterio.enums.ColorInterp.red,
			rasterio.enums.ColorInterp.green,
			rasterio.enums.ColorInterp.blue,
			rasterio.enums.ColorInterp.alpha,
		)

	assert standardise_geotiff(str(input_path), str(output_path), token='test-token', dataset_id=10388)

	with rasterio.open(output_path) as dst:
		assert dst.dtypes[0] == 'uint8'
		assert dst.count == 4
		alpha = dst.read(4)
		rgb = dst.read([1, 2, 3])

		assert np.all(alpha[transparent_mask] == 0)
		assert np.all(alpha[~transparent_mask] == 255)
		assert np.max(rgb[:, ~transparent_mask]) > 100


def test_final_warp_uses_deflate_for_low_band_jpeg_without_alpha_or_nodata(monkeypatch):
	commands: list[list[str]] = []

	def _run_success(command, check, capture_output, text):
		commands.append(command)
		return SimpleNamespace(stdout='ok', stderr='')

	monkeypatch.setattr(standardise_module.subprocess, 'run', _run_success)
	monkeypatch.setattr(standardise_module, 'verify_geotiff', lambda *args, **kwargs: True)

	assert _apply_final_transformations(
		'input.tif',
		'output.tif',
		original_nodata=None,
		final_nodata_value=None,
		num_bands=2,
		has_alpha=False,
		compression='JPEG',
		token='test-token',
		dataset_id=10388,
		user_id='test-user',
	)

	assert len(commands) == 1
	command = commands[0]
	assert 'COMPRESS=DEFLATE' in command
	assert 'PREDICTOR=2' in command
	assert 'COMPRESS=JPEG' not in command


def test_uint16_source_alpha_survives_byte_conversion(tmp_path):
	input_path = tmp_path / 'uint16_rgba_alpha_only.tif'
	output_path = tmp_path / 'rgba_standardized.tif'
	width = 72
	height = 72
	y, x = np.mgrid[0:height, 0:width]
	data = np.zeros((4, height, width), dtype=np.uint16)
	data[0] = 800 + x * 8
	data[1] = 1100 + y * 8
	data[2] = 900 + (x + y) * 4
	data[3] = 65535
	transparent_mask = np.zeros((height, width), dtype=bool)
	transparent_mask[:14, :] = True
	transparent_mask[34:48, 30:50] = True
	data[3, transparent_mask] = 0
	data[:3, 20, 20] = 0

	profile = {
		'driver': 'GTiff',
		'dtype': 'uint16',
		'width': width,
		'height': height,
		'count': 4,
		'crs': 'EPSG:32608',
		'transform': rasterio.transform.from_origin(442287.0, 7390649.0, 1.0, 1.0),
	}
	with rasterio.open(input_path, 'w', **profile) as dst:
		dst.write(data)
		dst.colorinterp = (
			rasterio.enums.ColorInterp.red,
			rasterio.enums.ColorInterp.green,
			rasterio.enums.ColorInterp.blue,
			rasterio.enums.ColorInterp.alpha,
		)

	assert standardise_geotiff(str(input_path), str(output_path), token='test-token', dataset_id=10388)

	with rasterio.open(output_path) as dst:
		assert dst.dtypes[0] == 'uint8'
		assert dst.count == 4
		assert dst.colorinterp[3] == rasterio.enums.ColorInterp.alpha
		alpha = dst.read(4)

		assert np.all(alpha[transparent_mask] == 0)
		assert np.all(alpha[~transparent_mask] == 255)
		assert alpha[20, 20] == 255
