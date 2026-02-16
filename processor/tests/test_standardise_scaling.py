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
from pathlib import Path

from processor.src.geotiff.standardise_geotiff import _handle_bit_depth_conversion


TEST_DATA_DIR = Path(__file__).parent.parent.parent / 'assets' / 'test_data'
WORLDVIEW_FIXTURE = TEST_DATA_DIR / 'worldview_uint16_crop.tif'


@pytest.fixture
def worldview_input():
	"""Path to the WorldView uint16 test fixture."""
	assert WORLDVIEW_FIXTURE.exists(), f'Test fixture not found: {WORLDVIEW_FIXTURE}'
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
