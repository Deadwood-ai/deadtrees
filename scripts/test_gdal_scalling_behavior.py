#!/usr/bin/env python3
"""
Quick test to verify GDAL's actual behavior with nodata and scaling
"""

import numpy as np
import rasterio
import subprocess
import tempfile
from pathlib import Path


def test_gdal_nodata_scaling():
	"""Test what GDAL actually does when combining -a_nodata and -scale"""

	# Create test data with known nodata values
	test_dir = Path('/tmp/gdal_test')
	test_dir.mkdir(exist_ok=True)

	# Test case 1: Float32 with -9999 nodata
	data = np.full((3, 100, 100), 50.0, dtype=np.float32)  # All pixels = 50
	data[:, 0:10, :] = -9999  # Top 10 rows are nodata

	profile = {
		'driver': 'GTiff',
		'dtype': 'float32',
		'nodata': -9999,
		'width': 100,
		'height': 100,
		'count': 3,
		'crs': 'EPSG:4326',
		'transform': rasterio.transform.from_bounds(0, 0, 1, 1, 100, 100),
	}

	input_path = test_dir / 'test_input.tif'
	output_path = test_dir / 'test_output.tif'

	# Create input file
	with rasterio.open(input_path, 'w', **profile) as dst:
		dst.write(data)

	print(f'Created test file: {input_path}')
	print(f'Input data range: {np.min(data)} to {np.max(data)}')
	print(f'Nodata value: {profile["nodata"]}')
	print(f'Nodata pixels: {np.sum(data == -9999)}')
	print(f'Valid pixels: {np.sum(data != -9999)}')

	# Test the exact command from your function
	cmd = [
		'gdal_translate',
		'-ot',
		'Byte',
		'-a_nodata',
		'-9999',  # Set nodata value
		'-scale',
		'0',
		'100',
		'0',
		'255',  # Scale 0-100 to 0-255
		str(input_path),
		str(output_path),
	]

	print(f'\nRunning command: {" ".join(cmd)}')
	result = subprocess.run(cmd, capture_output=True, text=True)

	if result.returncode != 0:
		print(f'ERROR: {result.stderr}')
		return False

	print(f'GDAL output: {result.stdout}')

	# Examine the output
	with rasterio.open(output_path) as dst:
		output_data = dst.read()
		print(f'\nOutput file info:')
		print(f'- Data type: {dst.profile["dtype"]}')
		print(f'- Nodata value: {dst.profile["nodata"]}')
		print(f'- Data range: {np.min(output_data)} to {np.max(output_data)}')
		print(f'- Unique values: {np.unique(output_data)}')

		# Count nodata pixels in output
		if dst.nodata is not None:
			nodata_count = np.sum(output_data == dst.nodata)
			print(f'- Nodata pixels in output: {nodata_count}')

		# Check if scaling worked correctly
		# Input valid pixels were 50, should become 50/100 * 255 = 127.5 ≈ 128
		valid_pixels = output_data[output_data != dst.nodata] if dst.nodata is not None else output_data
		if len(valid_pixels) > 0:
			expected_value = int(50.0 / 100.0 * 255)  # Should be 127-128
			actual_value = np.median(valid_pixels)
			print(f'- Expected scaled value: ~{expected_value}')
			print(f'- Actual median value: {actual_value}')

			if abs(actual_value - expected_value) <= 1:
				print('✅ Scaling worked correctly!')
			else:
				print("❌ Scaling didn't work as expected")

		return True


if __name__ == '__main__':
	test_gdal_nodata_scaling()
