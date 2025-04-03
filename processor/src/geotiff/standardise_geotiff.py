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
from shared.logging import LogContext, LogCategory
import rasterio
import numpy as np


def find_nodata_value(src, num_bands):
	"""Helper function to determine current nodata value from the source image"""
	try:
		# First check if nodata is explicitly set
		if src.nodata is not None:
			try:
				if not np.isnan(src.nodata):
					return src.nodata
			except:
				pass

		# Check if we have an alpha band (band 4 in RGBA)
		if num_bands == 4:
			try:
				# Read just a small window of the alpha band instead of the whole band
				window = rasterio.windows.Window(0, 0, min(100, src.width), min(100, src.height))
				alpha_band = src.read(4, window=window)
				if (alpha_band == 0).any():  # If alpha band has any zero values
					return 0
			except Exception as e:
				logger.warning(
					f'Error reading alpha band: {e}', LogContext(category=LogCategory.ORTHO, extra={'error': str(e)})
				)

		# Try to read edges in smaller chunks to avoid reading corrupted areas
		try:
			# Read just the first few pixels of edges instead of entire edges
			top = src.read(1, window=rasterio.windows.Window(0, 0, min(100, src.width), 1))
			bottom = src.read(1, window=rasterio.windows.Window(0, max(0, src.height - 1), min(100, src.width), 1))
			left = src.read(1, window=rasterio.windows.Window(0, 0, 1, min(100, src.height)))
			right = src.read(1, window=rasterio.windows.Window(max(0, src.width - 1), 0, 1, min(100, src.height)))

			edges = np.concatenate([top.flatten(), bottom.flatten(), left.flatten(), right.flatten()])

			# Find most common value in edges
			values, counts = np.unique(edges, return_counts=True)
			most_common_value = values[np.argmax(counts)]

			# If the most common value appears significantly more than others, it's likely nodata
			if np.max(counts) > len(edges) * 0.3:  # If value appears in more than 30% of edge pixels
				return most_common_value

		except Exception as e:
			logger.warning(
				f'Error reading image edges: {e}', LogContext(category=LogCategory.ORTHO, extra={'error': str(e)})
			)

		return None  # Return None if no clear nodata value is found or if errors occurred

	except Exception as e:
		logger.error(
			f'Error in find_nodata_value: {e}', LogContext(category=LogCategory.ORTHO, extra={'error': str(e)})
		)
		return None


def standardise_geotiff(
	input_path: str, output_path: str, token: str = None, dataset_id: int = None, user_id: str = None
) -> bool:
	"""
	Standardise a GeoTIFF by:
	1. Converting to 8-bit with auto-scaling if needed
	2. Creating a true alpha channel using internal TIFF masks
	3. Handling nodata values with transparency

	Args:
		input_path (str): Path to input GeoTIFF file
		output_path (str): Path for output standardized GeoTIFF
		token (str, optional): Authentication token for logging
		dataset_id (int, optional): Dataset ID for logging context
		user_id (str, optional): User ID for logging context

	Returns:
		bool: True if successful, False otherwise
	"""
	try:
		# Step 1: Validate and extract source image properties
		src_properties = _get_source_properties(input_path, token, dataset_id, user_id)
		if not src_properties:
			return False

		# Step 2: Handle bit depth conversion if needed
		processed_input = _handle_bit_depth_conversion(
			input_path, output_path, src_properties['dtype'], token, dataset_id, user_id
		)
		if not processed_input:
			return False

		# Step 3: Apply final transformations with gdalwarp
		success = _apply_final_transformations(
			processed_input,
			output_path,
			src_properties['nodata'],
			src_properties['num_bands'],
			token,
			dataset_id,
			user_id,
		)

		# Step 4: Clean up temporary file if it exists
		if processed_input != input_path:
			Path(processed_input).unlink()

		return success

	except Exception as e:
		logger.error(
			f'Unexpected error in standardise_geotiff: {e}',
			LogContext(
				category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token, extra={'error': str(e)}
			),
		)
		return False


def _get_source_properties(input_path: str, token: str, dataset_id: int = None, user_id: str = None) -> dict:
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
				logger.warning(
					'No CRS found in source file',
					LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
				)
				return None

			logger.info(
				f'Source properties - dtype: {properties["dtype"]}, bands: {properties["num_bands"]}, '
				f'nodata: {properties["nodata"]}',
				LogContext(
					category=LogCategory.ORTHO,
					dataset_id=dataset_id,
					user_id=user_id,
					token=token,
					extra={
						'dtype': properties['dtype'],
						'bands': properties['num_bands'],
						'nodata': properties['nodata'],
					},
				),
			)
			return properties

	except Exception as e:
		logger.error(
			f'Error reading source properties: {e}',
			LogContext(
				category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token, extra={'error': str(e)}
			),
		)
		return None


def _handle_bit_depth_conversion(
	input_path: str, output_path: str, src_dtype: str, token: str, dataset_id: int = None, user_id: str = None
) -> str:
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
		logger.info(
			'Running gdal_translate for scaling: ' + ' '.join(translate_cmd),
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'command': ' '.join(translate_cmd)},
			),
		)
		result = subprocess.run(translate_cmd, check=True, capture_output=True, text=True)
		logger.info(
			f'gdal_translate output:\n{result.stdout}',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		return temp_output
	except subprocess.CalledProcessError as e:
		logger.error(
			f'Error in bit depth conversion: {e}',
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'error': str(e), 'stderr': e.stderr},
			),
		)
		return None


def _apply_final_transformations(
	input_path: str,
	output_path: str,
	nodata: float,
	num_bands: int,
	token: str,
	dataset_id: int = None,
	user_id: str = None,
) -> bool:
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
		logger.info(
			'Running gdalwarp conversion: ' + ' '.join(cmd),
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'command': ' '.join(cmd)},
			),
		)
		result = subprocess.run(cmd, check=True, capture_output=True, text=True)
		logger.info(
			f'gdalwarp output:\n{result.stdout}',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)

		return verify_geotiff(output_path, token, dataset_id, user_id)
	except subprocess.CalledProcessError as e:
		logger.error(
			f'Error in final transformation: {e}',
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'error': str(e), 'stderr': e.stderr},
			),
		)
		return False


def verify_geotiff(file_path: str, token: str = None, dataset_id: int = None, user_id: str = None) -> bool:
	"""Verify GeoTIFF file integrity"""
	try:
		cmd = ['gdalinfo', file_path]
		result = subprocess.run(cmd, check=True, capture_output=True, text=True)
		verification_result = 'ERROR' not in result.stdout and 'FAILURE' not in result.stdout

		if verification_result:
			logger.info(
				f'GeoTIFF verification successful: {file_path}',
				LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
			)
		else:
			logger.error(
				f'GeoTIFF verification failed: {file_path}',
				LogContext(
					category=LogCategory.ORTHO,
					dataset_id=dataset_id,
					user_id=user_id,
					token=token,
					extra={'stdout': result.stdout},
				),
			)

		return verification_result
	except subprocess.CalledProcessError as e:
		logger.error(
			f'File verification failed: {e}',
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'error': str(e), 'stderr': e.stderr},
			),
		)
		return False


def update_ortho_table(
	file_path: Path, dataset_id: int, ortho_processing_runtime: float, token: str, user_id: str = None
):
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

			logger.info(
				f'Updated ortho table for dataset {dataset_id}',
				LogContext(
					category=LogCategory.ORTHO,
					dataset_id=dataset_id,
					user_id=user_id,
					token=token,
					extra={
						'file_name': file_path.name,
						'file_size': file_path.stat().st_size,
						'processing_runtime': ortho_processing_runtime,
					},
				),
			)

			return ortho
	except Exception as e:
		logger.error(
			f'Error updating ortho table: {e}',
			LogContext(
				category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token, extra={'error': str(e)}
			),
		)
		return None
