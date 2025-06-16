#!/usr/bin/env python3
"""
Debug script to analyze raster data values and understand dark image issues
"""

import rasterio
import numpy as np
from pathlib import Path
import sys


def analyze_raster_data(file_path: str):
	"""Analyze raster data to understand value distribution and potential issues"""

	print(f'Analyzing: {file_path}')
	print('=' * 60)

	with rasterio.open(file_path) as src:
		print(f'Basic Info:')
		print(f'  - Data type: {src.profile["dtype"]}')
		print(f'  - Bands: {src.count}')
		print(f'  - Width x Height: {src.width} x {src.height}')
		print(f'  - CRS: {src.crs}')
		print(f'  - NoData: {src.nodata}')
		print(f'  - Compression: {src.profile.get("compress", "None")}')

		# Read a sample of data from each band
		sample_size = min(1000, src.width), min(1000, src.height)
		window = rasterio.windows.Window(0, 0, sample_size[0], sample_size[1])

		print(f'\nData Analysis (sample {sample_size[0]}x{sample_size[1]}):')

		for band_idx in range(1, min(4, src.count + 1)):  # Analyze first 3 bands
			data = src.read(band_idx, window=window)

			# Basic statistics
			valid_data = data[~np.isnan(data)]

			print(f'\nBand {band_idx}:')
			print(f'  - Min: {np.min(valid_data):.3f}')
			print(f'  - Max: {np.max(valid_data):.3f}')
			print(f'  - Mean: {np.mean(valid_data):.3f}')
			print(f'  - Std: {np.std(valid_data):.3f}')
			print(f'  - Median: {np.median(valid_data):.3f}')
			print(f'  - NaN count: {np.sum(np.isnan(data))}')
			print(f'  - Zero count: {np.sum(data == 0)}')

			# Check value distribution
			unique_vals, counts = np.unique(valid_data, return_counts=True)
			print(f'  - Unique values: {len(unique_vals)}')
			print(f'  - Most common values: {unique_vals[np.argsort(counts)[-5:]]}')

			# Check for potential scaling issues
			if np.max(valid_data) <= 1.0:
				print(f'  - WARNING: Values appear to be normalized (0-1 range)')
			elif np.max(valid_data) > 1.0 and np.max(valid_data) <= 255:
				print(f'  - Values appear to be in 0-255 range')
			else:
				print(f'  - Values exceed typical RGB range')

		# Check for potential problems
		print(f'\nPotential Issues:')

		# Check if data is very dark
		all_data = src.read(window=window)
		if src.count >= 3:
			rgb_mean = np.mean(all_data[:3], axis=(1, 2))
			if np.all(rgb_mean < 50):
				print(f'  - WARNING: Image appears very dark (RGB means: {rgb_mean})')

		# Check for extreme values
		if np.any(all_data > 1000):
			print(f'  - WARNING: Some values are unusually high (>1000)')

		# Check data type vs value range mismatch
		if src.profile['dtype'] == 'float32' and np.max(all_data) <= 255:
			print(f'  - INFO: Float32 data with values in byte range - may need scaling')


def compare_before_after_cog(original_path: str, cog_path: str):
	"""Compare original and COG processed files"""

	print('Comparing Original vs COG:')
	print('=' * 60)

	with rasterio.open(original_path) as orig, rasterio.open(cog_path) as cog:
		# Read samples from both
		sample_size = min(500, orig.width, cog.width), min(500, orig.height, cog.height)
		window = rasterio.windows.Window(0, 0, sample_size[0], sample_size[1])

		orig_data = orig.read(window=window)
		cog_data = cog.read(window=window)

		print(f'Original - dtype: {orig.profile["dtype"]}, range: {np.min(orig_data):.3f} - {np.max(orig_data):.3f}')
		print(f'COG - dtype: {cog.profile["dtype"]}, range: {np.min(cog_data):.3f} - {np.max(cog_data):.3f}')

		# Check for data loss
		if orig.profile['dtype'] != cog.profile['dtype']:
			print(f'WARNING: Data type changed from {orig.profile["dtype"]} to {cog.profile["dtype"]}')

		if np.max(orig_data) > 255 and cog.profile['dtype'] == 'uint8':
			print(f'WARNING: Original data exceeds byte range but COG is uint8 - data clipping likely')

		# Compare compression
		orig_compress = orig.profile.get('compress', 'None')
		cog_compress = cog.profile.get('compress', 'None')
		print(f'Compression - Original: {orig_compress}, COG: {cog_compress}')


if __name__ == '__main__':
	if len(sys.argv) < 2:
		print('Usage: python debug_data_values.py <input_file> [cog_file]')
		sys.exit(1)

	input_file = sys.argv[1]
	if not Path(input_file).exists():
		print(f'File not found: {input_file}')
		sys.exit(1)

	# Analyze input file
	analyze_raster_data(input_file)

	# If COG file provided, compare
	if len(sys.argv) > 2:
		cog_file = sys.argv[2]
		if Path(cog_file).exists():
			print('\n')
			compare_before_after_cog(input_file, cog_file)
		else:
			print(f'COG file not found: {cog_file}')
