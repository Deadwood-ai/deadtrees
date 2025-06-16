#!/usr/bin/env python3
"""
Quick debug script to analyze the current COG processing issue
"""

import rasterio
import numpy as np
import sys
from pathlib import Path


def debug_cog_processing(original_path: str, processed_path: str):
	"""Debug the COG processing to understand why it's still black"""

	print('=== COG Processing Debug ===')
	print(f'Original: {original_path}')
	print(f'Processed: {processed_path}')
	print('=' * 50)

	# Check if files exist
	if not Path(original_path).exists():
		print(f'ERROR: Original file not found: {original_path}')
		return
	if not Path(processed_path).exists():
		print(f'ERROR: Processed file not found: {processed_path}')
		return

	# Analyze original file
	print('\n--- ORIGINAL FILE ---')
	with rasterio.open(original_path) as src:
		print(f'Data type: {src.profile["dtype"]}')
		print(f'Bands: {src.count}')
		print(f'NoData: {src.nodata}')
		print(f'Size: {src.width} x {src.height}')

		# Read sample data
		sample_window = rasterio.windows.Window(0, 0, min(500, src.width), min(500, src.height))
		sample_data = src.read(window=sample_window)

		print(f'Sample data shape: {sample_data.shape}')
		print(f'Data range: {np.nanmin(sample_data):.3f} - {np.nanmax(sample_data):.3f}')
		print(f'NaN count: {np.sum(np.isnan(sample_data))}')
		print(f'Zero count: {np.sum(sample_data == 0)}')

		# Check each band
		for i in range(min(3, src.count)):
			band_data = sample_data[i]
			valid_data = band_data[~np.isnan(band_data)]
			if len(valid_data) > 0:
				print(
					f'Band {i + 1}: min={np.min(valid_data):.3f}, max={np.max(valid_data):.3f}, mean={np.mean(valid_data):.3f}'
				)

	# Analyze processed file
	print('\n--- PROCESSED FILE ---')
	with rasterio.open(processed_path) as src:
		print(f'Data type: {src.profile["dtype"]}')
		print(f'Bands: {src.count}')
		print(f'NoData: {src.nodata}')
		print(f'Size: {src.width} x {src.height}')
		print(f'Compression: {src.profile.get("compress", "None")}')

		# Read sample data
		sample_window = rasterio.windows.Window(0, 0, min(500, src.width), min(500, src.height))
		sample_data = src.read(window=sample_window)

		print(f'Sample data shape: {sample_data.shape}')
		print(f'Data range: {np.nanmin(sample_data):.3f} - {np.nanmax(sample_data):.3f}')
		print(f'NaN count: {np.sum(np.isnan(sample_data))}')
		print(f'Zero count: {np.sum(sample_data == 0)}')

		# Check each band
		for i in range(min(3, src.count)):
			band_data = sample_data[i]
			valid_data = band_data[~np.isnan(band_data)]
			if len(valid_data) > 0:
				print(
					f'Band {i + 1}: min={np.min(valid_data):.3f}, max={np.max(valid_data):.3f}, mean={np.mean(valid_data):.3f}'
				)

		# Check for alpha band
		if src.count == 4:
			alpha_data = sample_data[3]
			print(
				f'Alpha band: min={np.min(alpha_data)}, max={np.max(alpha_data)}, unique values={np.unique(alpha_data)}'
			)

	# Compare the two
	print('\n--- COMPARISON ---')
	with rasterio.open(original_path) as orig, rasterio.open(processed_path) as proc:
		orig_sample = orig.read(window=rasterio.windows.Window(0, 0, min(500, orig.width), min(500, orig.height)))
		proc_sample = proc.read(window=rasterio.windows.Window(0, 0, min(500, proc.width), min(500, proc.height)))

		# Check if scaling happened
		orig_max = np.nanmax(orig_sample)
		proc_max = np.nanmax(proc_sample)

		print(f'Original max value: {orig_max:.3f}')
		print(f'Processed max value: {proc_max:.3f}')

		if orig_max > 255 and proc_max <= 255:
			print('✓ Data type conversion happened (Float32 → Byte)')
		else:
			print('⚠ Unexpected data range conversion')

		# Check scaling effectiveness
		if proc_max < 50:
			print('❌ PROBLEM: Processed image is very dark (max < 50)')
			print("   This suggests scaling didn't work properly")
		elif proc_max > 200:
			print('✓ Good brightness range achieved')
		else:
			print('⚠ Moderate brightness - could be better')

		# Check nodata handling
		orig_nan_count = np.sum(np.isnan(orig_sample))
		proc_zero_count = np.sum(proc_sample == 0)

		print(f'Original NaN pixels: {orig_nan_count}')
		print(f'Processed zero pixels: {proc_zero_count}')

		if proc.count == 4:  # Has alpha channel
			alpha_zero_count = np.sum(proc_sample[3] == 0)
			print(f'Alpha channel zero pixels: {alpha_zero_count}')
			if alpha_zero_count > 0:
				print('✓ Alpha channel created for transparency')
			else:
				print('⚠ Alpha channel exists but no transparent pixels')


if __name__ == '__main__':
	if len(sys.argv) != 3:
		print('Usage: python debug_current_cog.py <original_file> <processed_file>')
		sys.exit(1)

	debug_cog_processing(sys.argv[1], sys.argv[2])
