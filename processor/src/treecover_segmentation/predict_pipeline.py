#!/usr/bin/env python3
"""
TCD Pipeline prediction script for container execution.

This script replicates the original tree_cover_inference.py functionality
using the TCD Pipeline class directly, avoiding tile management issues.
"""

import sys
import os
import numpy as np
import rasterio

try:
	from tcd_pipeline.pipeline import Pipeline
except ImportError as e:
	print(f'Error importing TCD pipeline: {e}', file=sys.stderr)
	sys.exit(1)


def predict_with_pipeline(input_tif: str, output_confidence_map: str, threshold: int = 200):
	"""
	Run tree cover detection using TCD Pipeline and save confidence map.

	This replicates the original inference_forestcover() function but saves
	the confidence map as a GeoTIFF for further processing.

	Args:
	    input_tif (str): Path to input reprojected GeoTIFF
	    output_confidence_map (str): Path to save confidence map GeoTIFF
	    threshold (int): Confidence threshold (default: 200)

	Returns:
	    bool: True if successful, False otherwise
	"""
	try:
		print(f'Starting TCD Pipeline prediction for: {input_tif}')
		print(f'Output confidence map will be saved to: {output_confidence_map}')

		# Initialize the TCD pipeline with the segformer model
		print('Initializing TCD Pipeline...')
		pipeline = Pipeline(model_or_config='restor/tcd-segformer-mit-b5')

		# Run prediction - this handles all tiling internally
		print('Running TCD prediction...')
		result = pipeline.predict(input_tif)

		# Get confidence map from result
		print(f'Extracting confidence map... (type: {type(result.confidence_map)})')

		# Handle different confidence map types (same logic as old implementation)
		if hasattr(result.confidence_map, 'read'):
			# It's a DatasetReader - read the first band
			confidence_map = result.confidence_map.read(1)
			print('Read confidence map from DatasetReader')
		elif isinstance(result.confidence_map, np.ndarray):
			# It's already a numpy array
			confidence_map = result.confidence_map
			print('Using confidence map as numpy array')
		else:
			# Try to convert to numpy array
			try:
				confidence_map = np.array(result.confidence_map)
				print('Converted confidence map to numpy array')
			except Exception as e:
				raise TypeError(f'Cannot convert confidence_map to numpy array: {e}')

		print(f'Confidence map shape: {confidence_map.shape}')
		print(f'Confidence map dtype: {confidence_map.dtype}')
		print(f'Confidence map range: {confidence_map.min()} - {confidence_map.max()}')

		# Save confidence map as GeoTIFF with same spatial reference as input
		print(f'Saving confidence map to: {output_confidence_map}')

		with rasterio.open(input_tif) as src:
			# Create output profile based on input; clean incompatible keys
			profile = src.profile.copy()
			profile.update({'dtype': confidence_map.dtype, 'count': 1, 'compress': 'lzw'})
			# Ensure a concrete nodata value for mask-aware IO (uint8 -> 0)
			profile['nodata'] = 0
			# Remove keys that can conflict for single-band confidence maps
			for k in ('photometric', 'jpeg_quality'):
				if k in profile:
					profile.pop(k)

			# Update dimensions if they differ
			if confidence_map.shape != (src.height, src.width):
				profile.update({'height': confidence_map.shape[0], 'width': confidence_map.shape[1]})
				print(f'Updated profile dimensions to match confidence map: {confidence_map.shape}')

			# Write confidence map and propagate mask from input
			with rasterio.open(output_confidence_map, 'w', **profile) as dst:
				dst.write(confidence_map, 1)
				try:
					mask = src.dataset_mask()
					dst.write_mask(mask)
				except Exception as e:
					print(f'Warning: failed to write dataset mask: {e}')

		print(f'Successfully saved confidence map with shape {confidence_map.shape}')
		return True

	except Exception as e:
		print(f'Error in TCD Pipeline prediction: {str(e)}', file=sys.stderr)
		import traceback

		traceback.print_exc()
		return False


def main():
	"""Main entry point for the script."""
	if len(sys.argv) != 3:
		print('Usage: python predict_pipeline.py <input_tif> <output_confidence_map>', file=sys.stderr)
		print('', file=sys.stderr)
		print('Arguments:', file=sys.stderr)
		print('  input_tif: Path to input reprojected GeoTIFF file', file=sys.stderr)
		print('  output_confidence_map: Path to save output confidence map GeoTIFF', file=sys.stderr)
		sys.exit(1)

	input_tif = sys.argv[1]
	output_confidence_map = sys.argv[2]

	# Validate input file exists
	if not os.path.exists(input_tif):
		print(f'Error: Input file does not exist: {input_tif}', file=sys.stderr)
		sys.exit(1)

	# Create output directory if needed
	output_dir = os.path.dirname(output_confidence_map)
	if output_dir and not os.path.exists(output_dir):
		os.makedirs(output_dir)
		print(f'Created output directory: {output_dir}')

	# Run prediction
	success = predict_with_pipeline(input_tif, output_confidence_map)

	if success:
		print('TCD Pipeline prediction completed successfully!')
		sys.exit(0)
	else:
		print('TCD Pipeline prediction failed!', file=sys.stderr)
		sys.exit(1)


if __name__ == '__main__':
	main()
