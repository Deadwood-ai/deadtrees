#!/usr/bin/env python3
"""
Script to create small test versions of GeoTIFF files by cropping them to 1/10 size.
Reads from 'original' folder and saves to 'small' folder in assets/test_data/debugging/testcases.
"""

import argparse
from pathlib import Path
import rasterio
from rasterio.windows import Window
import shutil


def crop_geotiff_to_tenth(input_path: Path, output_path: Path) -> bool:
	"""
	Crop a GeoTIFF to 1/10 of its original size by taking a horizontal center stripe.
	This gives us edge pixels (left/right) and center pixels, providing better test coverage
	for both nodata values (at edges) and valid data (in center).

	Args:
	    input_path: Path to input GeoTIFF
	    output_path: Path for output cropped GeoTIFF

	Returns:
	    bool: True if successful, False otherwise
	"""
	try:
		with rasterio.open(input_path) as src:
			# Calculate new dimensions - horizontal stripe across full width
			original_width = src.width
			original_height = src.height

			# Take full width, but only 1/10 of height (horizontal stripe)
			new_width = original_width  # Keep full width to get edge-to-edge coverage
			new_height = max(1, original_height // 10)

			# Center the stripe vertically
			x_offset = 0  # Start from left edge
			y_offset = (original_height - new_height) // 2  # Center vertically

			window = Window(x_offset, y_offset, new_width, new_height)

			# Read the cropped data
			data = src.read(window=window)

			# Update the profile for the new file
			profile = src.profile.copy()
			profile.update(
				{
					'width': new_width,
					'height': new_height,
					'transform': rasterio.windows.transform(window, src.transform),
				}
			)

			# Create output directory if it doesn't exist
			output_path.parent.mkdir(parents=True, exist_ok=True)

			# Write the cropped data
			with rasterio.open(output_path, 'w', **profile) as dst:
				dst.write(data)

			print(f'Successfully cropped {input_path.name}')
			print(f'  Original size: {original_width}x{original_height}')
			print(f'  New size: {new_width}x{new_height}')
			print(f'  Cropped: horizontal center stripe (edges + center coverage)')
			print(f'  Saved to: {output_path}')

			return True

	except Exception as e:
		print(f'Error processing {input_path.name}: {str(e)}')
		return False


def main():
	parser = argparse.ArgumentParser(description='Create small test versions of GeoTIFF files')
	parser.add_argument(
		'--input-dir',
		type=str,
		default='assets/test_data/debugging/testcases/original',
		help='Input directory containing GeoTIFF files (default: original)',
	)
	parser.add_argument(
		'--output-dir',
		type=str,
		default='assets/test_data/debugging/testcases/small',
		help='Output directory for small files (default: assets/test_data/debugging/testcases/small)',
	)
	parser.add_argument('--overwrite', action='store_true', help='Overwrite existing files in output directory')

	args = parser.parse_args()

	# Set up paths
	script_dir = Path(__file__).parent
	workspace_root = script_dir.parent
	input_dir = workspace_root / args.input_dir
	output_dir = workspace_root / args.output_dir

	print(f'Input directory: {input_dir}')
	print(f'Output directory: {output_dir}')

	# Check if input directory exists
	if not input_dir.exists():
		print(f'Error: Input directory {input_dir} does not exist')
		print("Please create the 'original' folder and place your GeoTIFF files there.")
		return 1

	# Find all GeoTIFF files
	geotiff_patterns = ['*.tif', '*.tiff', '*.TIF', '*.TIFF']
	geotiff_files = []

	for pattern in geotiff_patterns:
		geotiff_files.extend(input_dir.glob(pattern))

	if not geotiff_files:
		print(f'No GeoTIFF files found in {input_dir}')
		return 1

	print(f'Found {len(geotiff_files)} GeoTIFF files to process')

	# Process each file
	success_count = 0
	for geotiff_file in geotiff_files:
		output_file = output_dir / f'small_{geotiff_file.name}'

		# Skip if file exists and not overwriting
		if output_file.exists() and not args.overwrite:
			print(f'Skipping {geotiff_file.name} (output exists, use --overwrite to replace)')
			continue

		if crop_geotiff_to_tenth(geotiff_file, output_file):
			success_count += 1

	print(f'\nProcessed {success_count}/{len(geotiff_files)} files successfully')

	if success_count > 0:
		print(f'\nSmall test files created in: {output_dir}')
		print('You can now run the comprehensive tests with these files.')

	return 0 if success_count == len(geotiff_files) else 1


if __name__ == '__main__':
	exit(main())
