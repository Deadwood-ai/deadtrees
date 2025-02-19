from datetime import datetime
import subprocess
from pathlib import Path
from shared.utils import get_transformed_bounds
from rio_cogeo.cogeo import cog_info
from shared.settings import settings
from shared.db import use_client
from shared.hash import get_file_identifier
from shared.logger import logger
from shared.models import Ortho
import rasterio
import numpy as np


def find_nodata_value(src, num_bands):
	"""Helper function to determine current nodata value from the source image"""
	# First check if nodata is explicitly set
	if src.nodata is not None:
		try:
			if not np.isnan(src.nodata):
				return src.nodata
			else:
				return None
		except Exception as e:
			logger.error(f'Error finding nodata value: {e}')
			pass

	# Check if we have an alpha band (band 4 in RGBA)
	if num_bands == 4:
		alpha_band = src.read(4)
		if (alpha_band == 0).any():  # If alpha band has any zero values
			return 0

	# Otherwise, analyze the first band for the most common value at the edges
	band1 = src.read(1)
	# Get edge pixels
	edges = np.concatenate(
		[
			band1[0, :],  # top edge
			band1[-1, :],  # bottom edge
			band1[:, 0],  # left edge
			band1[:, -1],  # right edge
		]
	)

	# Find most common value in edges
	values, counts = np.unique(edges, return_counts=True)
	most_common_value = values[np.argmax(counts)]

	# If the most common value appears significantly more than others, it's likely nodata
	if np.max(counts) > len(edges) * 0.3:  # If value appears in more than 30% of edge pixels
		return most_common_value

	return None  # Return None if no clear nodata value is found


def standardise_geotiff(input_path: str, output_path: str, token: str = None) -> bool:
	"""
	Standardise a GeoTIFF by:
	1. Converting to 8-bit with auto-scaling if needed
	2. Creating a true alpha channel using internal TIFF masks
	3. Handling nodata values with transparency

	Args:
		input_path (str): Path to input GeoTIFF file
		output_path (str): Path for output standardized GeoTIFF
		token (str, optional): Authentication token for logging

	Returns:
		bool: True if successful, False otherwise
	"""
	try:
		# Step 1: Validate and extract source image properties
		src_properties = _get_source_properties(input_path, token)
		if not src_properties:
			return False

		# Step 2: Handle bit depth conversion if needed
		processed_input = _handle_bit_depth_conversion(input_path, output_path, src_properties['dtype'], token)
		if not processed_input:
			return False

		# Step 3: Apply final transformations with gdalwarp
		success = _apply_final_transformations(
			processed_input, output_path, src_properties['nodata'], src_properties['num_bands'], token
		)

		# Step 4: Clean up temporary file if it exists
		if processed_input != input_path:
			Path(processed_input).unlink()

		return success

	except Exception as e:
		logger.error(f'Unexpected error in standardise_geotiff: {e}', extra={'token': token})
		return False


def _get_source_properties(input_path: str, token: str) -> dict:
	"""Extract and validate source image properties."""
	try:
		with rasterio.open(input_path) as src:
			properties = {
				'dtype': src.profile['dtype'],
				'num_bands': src.count,
				'crs': src.crs,
				'nodata': find_nodata_value(src, src.count),
			}

			if not properties['crs']:
				logger.warning('No CRS found in source file', extra={'token': token})
				return None

			logger.info(
				f'Source properties - dtype: {properties["dtype"]}, bands: {properties["num_bands"]}, '
				f'nodata: {properties["nodata"]}',
				extra={'token': token},
			)
			return properties

	except Exception as e:
		logger.error(f'Error reading source properties: {e}', extra={'token': token})
		return None


def _handle_bit_depth_conversion(input_path: str, output_path: str, src_dtype: str, token: str) -> str:
	"""Convert non-uint8 images to 8-bit using gdal_translate."""
	if src_dtype == 'uint8':
		return input_path

	temp_output = f'{output_path}.temp.tif'
	translate_cmd = [
		'gdal_translate',
		'-ot',
		'Byte',
		'-scale',  # Auto-scale
		input_path,
		temp_output,
	]

	try:
		logger.info('Running gdal_translate for scaling: ' + ' '.join(translate_cmd), extra={'token': token})
		result = subprocess.run(translate_cmd, check=True, capture_output=True, text=True)
		logger.info(f'gdal_translate output:\n{result.stdout}', extra={'token': token})
		return temp_output
	except subprocess.CalledProcessError as e:
		logger.error(f'Error in bit depth conversion: {e}', extra={'token': token})
		return None


def _apply_final_transformations(input_path: str, output_path: str, nodata: float, num_bands: int, token: str) -> bool:
	"""Apply final transformations using gdalwarp."""
	cmd = [
		'gdalwarp',
		'-of',
		'GTiff',
		'-co',
		'TILED=YES',
		'-co',
		'COMPRESS=DEFLATE',
		'-co',
		'PREDICTOR=2',
		'-co',
		'BIGTIFF=YES',
		'--config',
		'GDAL_TIFF_INTERNAL_MASK',
		'YES',
		'--config',
		'GDAL_NUM_THREADS',
		'ALL_CPUS',
	]

	# Add nodata handling
	if nodata is not None:
		cmd.extend(['-srcnodata', str(nodata), '-dstnodata', '0', '-dstalpha'])

	# Handle band selection for RGB
	if num_bands > 3:
		cmd.extend(['-b', '1', '-b', '2', '-b', '3'])

	cmd.extend([input_path, output_path])

	try:
		logger.info('Running gdalwarp conversion: ' + ' '.join(cmd), extra={'token': token})
		result = subprocess.run(cmd, check=True, capture_output=True, text=True)
		logger.info(f'gdalwarp output:\n{result.stdout}', extra={'token': token})

		return verify_geotiff(output_path, token)
	except subprocess.CalledProcessError as e:
		logger.error(f'Error in final transformation: {e}', extra={'token': token})
		return False


def verify_geotiff(file_path: str, token: str = None) -> bool:
	"""Verify GeoTIFF file integrity"""
	try:
		cmd = ['gdalinfo', file_path]
		result = subprocess.run(cmd, check=True, capture_output=True, text=True)
		return 'ERROR' not in result.stdout and 'FAILURE' not in result.stdout
	except subprocess.CalledProcessError as e:
		logger.error(f'File verification failed: {e}', extra={'token': token})
		return False


def update_ortho_table(file_path: Path, dataset_id: int, ortho_processing_runtime: float, token: str):
	"""Update the ortho table with the new ortho file information"""
	try:
		info = cog_info(str(file_path))
		sha256 = get_file_identifier(file_path)
		bbox = get_transformed_bounds(file_path)
		ortho = Ortho(
			dataset_id=dataset_id,
			ortho_file_name=file_path.name,
			version=1,
			created_at=datetime.now(),
			file_size=file_path.stat().st_size,
			sha256=sha256,
			ortho_info=info.model_dump(),
			ortho_processed=True,
			ortho_processing_runtime=ortho_processing_runtime,
		)

		with use_client(token) as client:
			client.table(settings.orthos_table).upsert(ortho.model_dump()).execute()
			return ortho
	except Exception as e:
		logger.error(f'Error updating ortho table: {e}', extra={'token': token})
		return None
