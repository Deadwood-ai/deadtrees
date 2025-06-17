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
			if np.isnan(src.nodata):
				# This is our main problem case - NaN nodata
				logger.info(
					'Detected NaN nodata in source file',
					LogContext(category=LogCategory.ORTHO, extra={'nodata_type': 'nan'}),
				)
				return 'nan'  # Return string to distinguish from numeric values
			else:
				return src.nodata

		# For the rest of the function, we need to be careful about NaN values
		# when reading sample data

		# Check if we have an alpha band (band 4 in RGBA)
		if num_bands == 4:
			try:
				window = rasterio.windows.Window(0, 0, min(100, src.width), min(100, src.height))
				alpha_band = src.read(4, window=window)
				if (alpha_band == 0).any():
					return 0
			except Exception as e:
				logger.warning(
					f'Error reading alpha band: {e}', LogContext(category=LogCategory.ORTHO, extra={'error': str(e)})
				)

		# Sample edges to detect nodata, being careful with NaN values
		try:
			top = src.read(1, window=rasterio.windows.Window(0, 0, min(100, src.width), 1))
			bottom = src.read(1, window=rasterio.windows.Window(0, max(0, src.height - 1), min(100, src.width), 1))
			left = src.read(1, window=rasterio.windows.Window(0, 0, 1, min(100, src.height)))
			right = src.read(1, window=rasterio.windows.Window(max(0, src.width - 1), 0, 1, min(100, src.height)))

			edges = np.concatenate([top.flatten(), bottom.flatten(), left.flatten(), right.flatten()])

			# Check for NaN in edges
			nan_count = np.sum(np.isnan(edges))
			total_count = len(edges)
			nan_percentage = nan_count / total_count

			if nan_percentage > 0.5:  # If more than 50% of edges are NaN
				logger.info(
					f'High NaN percentage in edges: {nan_percentage * 100:.1f}%',
					LogContext(category=LogCategory.ORTHO, extra={'nan_percentage': nan_percentage}),
				)
				return 'nan'

			# Continue with existing logic for non-NaN edges
			edges_clean = edges[~np.isnan(edges)]

			if len(edges_clean) == 0:
				return 'nan'  # All edges are NaN

			values, counts = np.unique(edges_clean, return_counts=True)
			most_common_value = values[np.argmax(counts)]

			if np.max(counts) > len(edges_clean) * 0.3:
				return most_common_value

		except Exception as e:
			logger.warning(
				f'Error reading image edges: {e}', LogContext(category=LogCategory.ORTHO, extra={'error': str(e)})
			)

		return None

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

		# Step 2: Handle bit depth conversion if needed (now returns nodata value)
		processed_input, final_nodata_value = _handle_bit_depth_conversion(
			input_path, output_path, src_properties['dtype'], token, dataset_id, user_id
		)
		if not processed_input:
			return False

		# Step 3: Apply final transformations with gdalwarp (pass the actual nodata value)
		success = _apply_final_transformations(
			processed_input,
			output_path,
			src_properties['nodata'],
			final_nodata_value,  # Pass the actual nodata value from intermediate file
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
) -> tuple:
	"""Convert non-uint8 images to 8-bit using gdal_translate with proper nodata handling."""
	if src_dtype == 'uint8':
		# For uint8 files, we still need to detect and return the nodata value
		with rasterio.open(input_path) as src:
			detected_nodata = find_nodata_value(src, src.count)
			explicit_nodata = src.nodata

			# Return the original nodata value for transparency handling
			final_nodata = explicit_nodata if explicit_nodata is not None else detected_nodata
			return input_path, final_nodata

	temp_output = f'{output_path}.temp.tif'

	# Get nodata information and calculate proper scaling
	with rasterio.open(input_path) as src:
		detected_nodata = find_nodata_value(src, src.count)
		explicit_nodata = src.nodata

		# Calculate scaling parameters by reading from center of image
		logger.info(
			'Calculating scaling parameters from center region',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)

		# Sample from center quarter of the image to avoid edge nodata
		center_x = src.width // 4
		center_y = src.height // 4
		center_width = src.width // 2
		center_height = src.height // 2

		sample_window = rasterio.windows.Window(center_x, center_y, center_width, center_height)
		sample_data = src.read(window=sample_window)

		# Remove NaN values and any detected nodata for proper min/max calculation
		valid_mask = ~np.isnan(sample_data)

		# Exclude explicit nodata values from scaling calculation
		if explicit_nodata is not None and not np.isnan(explicit_nodata):
			valid_mask = valid_mask & (sample_data != explicit_nodata)

		# Exclude detected nodata values (if numeric)
		if detected_nodata is not None and detected_nodata != 'nan':
			try:
				detected_numeric = float(detected_nodata)
				valid_mask = valid_mask & (sample_data != detected_numeric)
			except (ValueError, TypeError):
				pass  # detected_nodata is not numeric

		valid_data = sample_data[valid_mask]

		if len(valid_data) > 0:
			data_min = float(np.min(valid_data))
			data_max = float(np.max(valid_data))
			logger.info(
				f'Calculated data range (excluding nodata): {data_min:.3f} - {data_max:.3f}',
				LogContext(
					category=LogCategory.ORTHO,
					dataset_id=dataset_id,
					user_id=user_id,
					token=token,
					extra={'data_min': data_min, 'data_max': data_max},
				),
			)
		else:
			# Fallback if no valid data found
			data_min, data_max = 0.0, 255.0
			logger.warning(
				'No valid data found for scaling, using default range',
				LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
			)

		# Log nodata detection results
		logger.info(
			f'NoData analysis - explicit: {explicit_nodata}, detected: {detected_nodata}',
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'explicit_nodata': str(explicit_nodata), 'detected_nodata': str(detected_nodata)},
			),
		)

	# Build translate command - PRESERVE original nodata values
	translate_cmd = ['gdal_translate', '-ot', 'Byte']

	# Determine what nodata value to preserve in the output
	final_nodata_value = None

	if explicit_nodata is not None and np.isnan(explicit_nodata):
		# NaN nodata - convert to 0 (since Byte format can't store NaN)
		logger.info(
			'Converting NaN nodata to 0 (Byte format limitation)',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		translate_cmd.extend(['-a_nodata', '0'])
		final_nodata_value = 0
	elif detected_nodata == 'nan':
		# Detected NaN nodata - convert to 0
		logger.info(
			'Converting detected NaN nodata to 0 (Byte format limitation)',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		translate_cmd.extend(['-a_nodata', '0'])
		final_nodata_value = 0
	elif explicit_nodata is not None:
		# Preserve explicit numeric nodata value
		nodata_int = int(explicit_nodata)
		logger.info(
			f'Preserving explicit nodata value: {nodata_int}',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		translate_cmd.extend(['-a_nodata', str(nodata_int)])
		final_nodata_value = nodata_int
	elif detected_nodata is not None and detected_nodata != 'nan':
		# Preserve detected numeric nodata value
		try:
			nodata_int = int(float(detected_nodata))
			logger.info(
				f'Preserving detected nodata value: {nodata_int}',
				LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
			)
			translate_cmd.extend(['-a_nodata', str(nodata_int)])
			final_nodata_value = nodata_int
		except (ValueError, TypeError):
			logger.warning(
				f'Could not convert detected nodata to integer: {detected_nodata}',
				LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
			)
	else:
		logger.info(
			'No nodata values detected',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)

	# Add EXPLICIT scaling
	translate_cmd.extend(['-scale', str(data_min), str(data_max), '0', '255'])
	translate_cmd.extend([input_path, temp_output])

	try:
		logger.info(
			'Running gdal_translate preserving original nodata: ' + ' '.join(translate_cmd),
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'command': ' '.join(translate_cmd), 'final_nodata': final_nodata_value},
			),
		)
		result = subprocess.run(translate_cmd, check=True, capture_output=True, text=True)
		logger.info(
			f'gdal_translate output:\n{result.stdout}',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		return temp_output, final_nodata_value

	except subprocess.CalledProcessError as e:
		logger.error(
			f'Error in bit depth conversion: {e}',
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'error': str(e), 'stderr': e.stderr if hasattr(e, 'stderr') else 'No stderr available'},
			),
		)
		return None, None


def _apply_final_transformations(
	input_path: str,
	output_path: str,
	original_nodata: float,
	final_nodata_value: int,  # The actual nodata value in the intermediate file
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

	# Use the actual nodata value from the intermediate file
	if final_nodata_value is not None:
		logger.info(
			f'Creating alpha channel for transparency (using actual nodata: {final_nodata_value})',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		cmd.extend(['-srcnodata', str(final_nodata_value), '-dstalpha'])
	else:
		logger.info(
			'No nodata handling needed',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)

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
	"""Verify GeoTIFF file integrity using rio_cogeo.cog_info"""
	try:
		# Verify the GeoTIFF by attempting to get its info
		info = cog_info(file_path)

		# If we get here, the file is valid
		logger.info(
			f'GeoTIFF verification successful: {file_path}',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		return True

	except Exception as e:
		logger.error(
			f'GeoTIFF verification failed: {e}',
			LogContext(
				category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token, extra={'error': str(e)}
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
