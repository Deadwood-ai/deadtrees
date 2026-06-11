from datetime import datetime
import subprocess
import shutil
from pathlib import Path
from shared.utils import get_transformed_bounds
from rio_cogeo.cogeo import cog_info
from shared.settings import settings
from shared.db import use_client
from shared.hash import get_file_identifier
from shared.logger import logger
from shared.models import Ortho
from shared.logging import LogContext, LogCategory
from processor.src.exceptions import ConversionError
import rasterio
import rasterio.enums
import numpy as np


def _as_python_scalar(value):
	if isinstance(value, np.generic):
		return value.item()
	return value


def _has_alpha_band(src) -> bool:
	try:
		return src.count >= 2 and src.colorinterp[src.count - 1] == rasterio.enums.ColorInterp.alpha
	except (IndexError, AttributeError):
		return False


def _check_if_already_standardized(
	input_path: str, token: str = None, dataset_id: int = None, user_id: str = None
) -> dict:
	"""
	Check if the input file already meets standardization requirements.

	Returns dict with:
	- is_standardized: bool - True if file meets all requirements
	- has_alpha: bool - True if file has an alpha band
	- is_lossy: bool - True if file uses lossy compression (WEBP, JPEG, etc.)
	- compression: str - Original compression type
	- details: dict - Details about the file properties
	"""
	# Lossy compression formats that should be preserved
	LOSSY_COMPRESSIONS = {'WEBP', 'JPEG', 'JPEG2000', 'JPEGXL'}

	try:
		with rasterio.open(input_path) as src:
			is_uint8 = src.profile['dtype'] == 'uint8'
			is_tiled = src.profile.get('tiled', False)
			compression = src.profile.get('compress', '').upper()
			has_compression = compression != ''
			num_bands = src.count

			# Detect lossy compression
			is_lossy = compression in LOSSY_COMPRESSIONS

			# Check if band 4 is an alpha channel
			has_alpha = False
			has_alpha = _has_alpha_band(src)

			# File is standardized if it's uint8, tiled, and compressed
			is_standardized = is_uint8 and is_tiled and has_compression

			details = {
				'dtype': src.profile['dtype'],
				'tiled': is_tiled,
				'compression': compression,
				'num_bands': num_bands,
				'has_alpha': has_alpha,
				'is_lossy': is_lossy,
			}

			logger.info(
				f'File check - standardized: {is_standardized}, details: {details}',
				LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
			)

			return {
				'is_standardized': is_standardized,
				'has_alpha': has_alpha,
				'is_lossy': is_lossy,
				'compression': compression,
				'details': details,
			}
	except Exception as e:
		logger.warning(
			f'Error checking if file is standardized: {e}',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		return {'is_standardized': False, 'has_alpha': False, 'is_lossy': False, 'compression': '', 'details': {}}


def find_nodata_value(src, num_bands, token: str = None, dataset_id: int = None, user_id: str = None):
	"""Helper function to determine current nodata value from the source image"""
	try:
		# First check if nodata is explicitly set
		if src.nodata is not None:
			if np.isnan(src.nodata):
				# This is our main problem case - NaN nodata
				logger.info(
					'Detected NaN nodata in source file',
					LogContext(
						category=LogCategory.ORTHO,
						dataset_id=dataset_id,
						user_id=user_id,
						token=token,
						extra={'nodata_type': 'nan'},
					),
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
					f'Error reading alpha band: {e}',
					LogContext(
						category=LogCategory.ORTHO,
						dataset_id=dataset_id,
						user_id=user_id,
						token=token,
						extra={'error': str(e)},
					),
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
					LogContext(
						category=LogCategory.ORTHO,
						dataset_id=dataset_id,
						user_id=user_id,
						token=token,
						extra={'nan_percentage': nan_percentage},
					),
				)
				return 'nan'

			# Continue with existing logic for non-NaN edges
			edges_clean = edges[~np.isnan(edges)]

			if len(edges_clean) == 0:
				return 'nan'  # All edges are NaN

			values, counts = np.unique(edges_clean, return_counts=True)
			most_common_value = values[np.argmax(counts)]

			if np.max(counts) > len(edges_clean) * 0.3:
				return _as_python_scalar(most_common_value)

		except Exception as e:
			logger.warning(
				f'Error reading image edges: {e}',
				LogContext(
					category=LogCategory.ORTHO,
					dataset_id=dataset_id,
					user_id=user_id,
					token=token,
					extra={'error': str(e)},
				),
			)

		return None

	except Exception as e:
		logger.error(
			f'Error in find_nodata_value: {e}',
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'error': str(e)},
			),
		)
		return None


def _source_nodata_mask(source_data: np.ndarray, nodata_value) -> np.ndarray:
	"""Return pixels where all selected source bands are nodata."""
	if nodata_value is None:
		return np.zeros(source_data.shape[1:], dtype=bool)
	if nodata_value == 'nan':
		if not np.issubdtype(source_data.dtype, np.floating):
			return np.zeros(source_data.shape[1:], dtype=bool)
		return np.all(np.isnan(source_data), axis=0)
	try:
		numeric_nodata = float(nodata_value)
	except (TypeError, ValueError):
		return np.zeros(source_data.shape[1:], dtype=bool)
	return np.all(source_data == numeric_nodata, axis=0)


def _is_extreme_value_for_dtype(value: float, dtype: str) -> bool:
	try:
		np_dtype = np.dtype(dtype)
	except TypeError:
		return False
	if np.issubdtype(np_dtype, np.integer):
		info = np.iinfo(np_dtype)
		return value in {float(info.min), float(info.max)}
	return False


def _is_plausible_detected_nodata(value: float, dtype: str) -> bool:
	try:
		np_dtype = np.dtype(dtype)
	except TypeError:
		return False
	if np.issubdtype(np_dtype, np.floating):
		return np.isfinite(value)
	if not np.issubdtype(np_dtype, np.integer):
		return False

	info = np.iinfo(np_dtype)
	integer_value = int(value)
	if value != float(integer_value):
		return False
	if integer_value == 0:
		return True
	if abs(integer_value - int(info.min)) <= 1 or abs(integer_value - int(info.max)) <= 1:
		return True
	return integer_value < 0 and abs(integer_value) in {999, 9999, 32767, 32768}


def _add_alpha_from_source_nodata(
	input_path: str,
	byte_output_path: str,
	source_nodata_value,
	bands_to_process: int,
	source_alpha_band_index: int | None = None,
	token: str = None,
	dataset_id: int = None,
	user_id: str = None,
) -> str:
	"""Create an RGBA byte file whose alpha is derived from source nodata.

	Nodata values such as 65535 cannot be represented after `-ot Byte`.
	GDAL scaling clips them to 255 unless transparency is derived from the
	original source values before the final warp step.
	"""
	if source_nodata_value is None and source_alpha_band_index is None:
		return byte_output_path

	indexes = list(range(1, bands_to_process + 1))
	alpha_output_path = f'{byte_output_path}.alpha.tif'
	with rasterio.open(input_path) as src, rasterio.open(byte_output_path) as byte_src:
		profile = byte_src.profile.copy()
		profile.pop('photometric', None)
		profile.update(count=4, dtype='uint8', nodata=None, compress='DEFLATE', predictor=2)

		with rasterio.open(alpha_output_path, 'w', **profile) as dst:
			dst.colorinterp = (
				rasterio.enums.ColorInterp.red,
				rasterio.enums.ColorInterp.green,
				rasterio.enums.ColorInterp.blue,
				rasterio.enums.ColorInterp.alpha,
			)
			for _, window in byte_src.block_windows(1):
				byte_data = byte_src.read(indexes=indexes, window=window, masked=False)
				source_data = src.read(indexes=indexes, window=window, masked=False)
				nodata_mask = _source_nodata_mask(source_data, source_nodata_value)
				if source_alpha_band_index is not None:
					source_alpha = src.read(source_alpha_band_index, window=window, masked=False)
					# The public COG path uses binary masks, so preserve fully transparent
					# source pixels while treating any nonzero alpha as valid data.
					nodata_mask |= source_alpha == 0
				alpha = np.full(nodata_mask.shape, 255, dtype=np.uint8)
				if np.any(nodata_mask):
					byte_data[:, nodata_mask] = 0
					alpha[nodata_mask] = 0
				if bands_to_process == 1:
					rgb_data = np.repeat(byte_data[:1], 3, axis=0)
				elif bands_to_process == 2:
					rgb_data = np.concatenate([byte_data[:2], byte_data[:1]], axis=0)
				else:
					rgb_data = byte_data[:3]
				dst.write(rgb_data, indexes=[1, 2, 3], window=window)
				dst.write(alpha, indexes=4, window=window)

	logger.info(
		f'Added alpha band from source nodata value: {source_nodata_value}',
		LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
	)
	Path(byte_output_path).unlink()
	return alpha_output_path


def standardise_geotiff(
	input_path: str, output_path: str, token: str = None, dataset_id: int = None, user_id: str = None
) -> bool:
	"""
	Standardise a GeoTIFF by:
	1. Checking if already standardized (uint8, tiled, compressed) - if yes, just copy
	2. Converting to 8-bit with auto-scaling if needed
	3. Creating a true alpha channel using internal TIFF masks
	4. Handling nodata values with transparency
	5. Properly preserving existing alpha bands without conflicting instructions

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
		# Step 0: Check if file is already standardized
		check_result = _check_if_already_standardized(input_path, token, dataset_id, user_id)

		if check_result['is_standardized']:
			logger.info(
				'File already meets standardization requirements, copying instead of reprocessing',
				LogContext(
					category=LogCategory.ORTHO,
					dataset_id=dataset_id,
					user_id=user_id,
					token=token,
					extra={'details': check_result['details']},
				),
			)
			# Just copy the file to preserve original compression
			shutil.copy2(input_path, output_path)
			return verify_geotiff(output_path, token, dataset_id, user_id)

		logger.info(
			'File needs standardization processing',
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'details': check_result['details']},
			),
		)

		# Step 1: Validate and extract source image properties
		# _get_source_properties now raises ConversionError on failure
		src_properties = _get_source_properties(input_path, token, dataset_id, user_id)

		# Add has_alpha and compression info to properties for later use
		src_properties['has_alpha'] = check_result['has_alpha']
		src_properties['is_lossy'] = check_result['is_lossy']
		src_properties['compression'] = check_result['compression']

		# Step 2: Handle bit depth conversion if needed (now returns nodata value)
		processed_input, final_nodata_value = _handle_bit_depth_conversion(
			input_path,
			output_path,
			src_properties['dtype'],
			src_properties['has_alpha'],
			src_properties['compression'],
			token,
			dataset_id,
			user_id,
		)
		if not processed_input:
			return False

		with rasterio.open(processed_input) as processed_src:
			processed_num_bands = processed_src.count
			processed_has_alpha = _has_alpha_band(processed_src)

		# Step 3: Apply final transformations with gdalwarp (pass the actual nodata value AND alpha info AND compression)
		success = _apply_final_transformations(
			processed_input,
			output_path,
			src_properties['nodata'],
			final_nodata_value,  # Pass the actual nodata value from intermediate file
			processed_num_bands,
			processed_has_alpha,  # Pass alpha band info to avoid conflicts
			src_properties['compression'],  # Pass original compression to preserve lossy formats
			token,
			dataset_id,
			user_id,
		)

		# Step 4: Clean up temporary file if it exists
		if processed_input != input_path:
			Path(processed_input).unlink()

		return success

	except ConversionError:
		raise  # Re-raise ConversionError with specific reason
	except MemoryError as e:
		error_msg = f'Out of memory processing file. File may be too large ({e})'
		logger.error(
			error_msg,
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		raise ConversionError('Standardization failed', error_msg, dataset_id=dataset_id)
	except Exception as e:
		error_msg = str(e)
		# Check for common memory-related errors
		if 'Unable to allocate' in error_msg or 'MemoryError' in error_msg:
			error_msg = f'Out of memory: {error_msg}'
		logger.error(
			f'Unexpected error in standardise_geotiff: {e}',
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={'error': error_msg},
			),
		)
		raise ConversionError('Standardization failed', error_msg, dataset_id=dataset_id)


def _get_source_properties(input_path: str, token: str, dataset_id: int = None, user_id: str = None) -> dict:
	"""Extract and validate source image properties."""
	try:
		with rasterio.open(input_path) as src:
			properties = {
				'dtype': src.profile['dtype'],
				'num_bands': src.count,
				'crs': src.crs,
				'nodata': find_nodata_value(src, src.count, token=token, dataset_id=dataset_id, user_id=user_id),
			}

			if not properties['crs']:
				# Check if file has transform info but no CRS
				has_transform = src.transform and src.transform != rasterio.transform.Affine.identity()
				origin = [src.transform.c, src.transform.f] if src.transform else [0, 0]

				if has_transform and (origin[0] != 0 or origin[1] != 0):
					# File has coordinates but no CRS definition
					error_msg = (
						f'File has coordinates (origin: {origin[0]:.1f}, {origin[1]:.1f}) but no CRS definition. '
						'The projection system is unknown. Please re-export with embedded CRS or provide a .prj file.'
					)
				else:
					# File has no georeferencing at all
					error_msg = (
						'File has no coordinate reference system (CRS) or georeferencing. '
						'This appears to be a plain image, not a georeferenced orthomosaic. '
						'Please upload a GeoTIFF with embedded CRS or include a world file (.tfw).'
					)

				logger.warning(
					error_msg,
					LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
				)
				raise ConversionError('Standardization failed', error_msg, dataset_id=dataset_id)

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

	except ConversionError:
		raise  # Re-raise ConversionError without wrapping
	except Exception as e:
		logger.error(
			f'Error reading source properties: {e}',
			LogContext(
				category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token, extra={'error': str(e)}
			),
		)
		raise ConversionError('Standardization failed', f'Error reading file: {str(e)}', dataset_id=dataset_id)


def _handle_bit_depth_conversion(
	input_path: str,
	output_path: str,
	src_dtype: str,
	has_alpha: bool,
	compression: str,
	token: str,
	dataset_id: int = None,
	user_id: str = None,
) -> tuple:
	"""
	Convert non-uint8 images to 8-bit using gdal_translate with proper nodata handling.

	Args:
		has_alpha: If True, file already has alpha band so nodata detection is skipped
		compression: Original compression type to preserve (especially for lossy formats like WEBP, JPEG)
	"""
	if src_dtype == 'uint8':
		# For uint8 files, check if we need nodata detection
		if has_alpha:
			# File has alpha band - no need to detect nodata (alpha handles transparency)
			logger.info(
				'File has alpha band, skipping nodata detection (alpha handles transparency)',
				LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
			)
			return input_path, None
		else:
			# No alpha band - detect nodata for creating alpha from it
			with rasterio.open(input_path) as src:
				detected_nodata = find_nodata_value(
					src,
					src.count,
					token=token,
					dataset_id=dataset_id,
					user_id=user_id,
				)
				explicit_nodata = src.nodata

				# Return the original nodata value for transparency handling
				final_nodata = explicit_nodata if explicit_nodata is not None else detected_nodata
				return input_path, final_nodata

	temp_output = f'{output_path}.temp.tif'

	# Determine compression to use - preserve original if specified
	compress_arg = compression if compression else 'DEFLATE'

	logger.info(
		f'Converting {src_dtype} to uint8 with {compress_arg} compression',
		LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
	)

	# Get nodata information and calculate proper scaling
	with rasterio.open(input_path) as src:
		detected_nodata = find_nodata_value(src, src.count, token=token, dataset_id=dataset_id, user_id=user_id)
		explicit_nodata = src.nodata
		source_has_alpha = _has_alpha_band(src)
		source_alpha_band_index = src.count if source_has_alpha else None
		if source_has_alpha and explicit_nodata is None:
			detected_nodata = None

		# Calculate scaling parameters by reading from center of image
		logger.info(
			'Calculating per-band scaling parameters from center region',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)

		# Sample from center quarter of the image to avoid edge nodata
		center_x = src.width // 4
		center_y = src.height // 4
		center_width = src.width // 2
		center_height = src.height // 2

		sample_window = rasterio.windows.Window(center_x, center_y, center_width, center_height)
		sample_data = src.read(window=sample_window)
		sample_alpha_mask = None
		if source_has_alpha:
			sample_alpha_mask = sample_data[source_alpha_band_index - 1] > 0

		# Calculate min/max per band for RGB only (first 3 bands)
		data_band_count = src.count - 1 if source_has_alpha else src.count
		bands_to_analyze = min(data_band_count, 3)  # Only analyze RGB/display bands
		band_ranges = []

		for band_idx in range(bands_to_analyze):
			band_data = sample_data[band_idx]

			# Remove NaN values and any detected nodata for proper min/max calculation
			valid_mask = ~np.isnan(band_data)
			if sample_alpha_mask is not None:
				valid_mask = valid_mask & sample_alpha_mask

			# Exclude explicit nodata values from scaling calculation
			if explicit_nodata is not None and not np.isnan(explicit_nodata):
				valid_mask = valid_mask & (band_data != explicit_nodata)

			# Exclude detected nodata values (if numeric)
			if detected_nodata is not None and detected_nodata != 'nan':
				try:
					detected_numeric = float(detected_nodata)
					valid_mask = valid_mask & (band_data != detected_numeric)
				except (ValueError, TypeError):
					pass  # detected_nodata is not numeric

			valid_band_data = band_data[valid_mask]

			if len(valid_band_data) > 0:
				# Use percentile-based scaling to avoid outlier-skewed contrast stretch.
				# Raw min/max causes most pixel data to be compressed into a tiny dark range
				# when a few extreme outlier pixels define the scaling bounds (e.g., WorldView uint16).
				band_min = float(np.percentile(valid_band_data, 2))
				band_max = float(np.percentile(valid_band_data, 98))
			else:
				# Fallback if no valid data found for this band
				band_min, band_max = 0.0, 255.0
				logger.warning(
					f'No valid data found for band {band_idx + 1}, using default range',
					LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
				)

			band_ranges.append((band_min, band_max))
			logger.info(
				f'Band {band_idx + 1} range: {band_min:.3f} - {band_max:.3f}',
				LogContext(
					category=LogCategory.ORTHO,
					dataset_id=dataset_id,
					user_id=user_id,
					token=token,
					extra={'band': band_idx + 1, 'band_min': band_min, 'band_max': band_max},
				),
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
	# Only process RGB bands (1-3) - extra bands (multispectral, undefined) are not needed
	# and can cause issues (e.g., constant-value bands cause GDAL scaling divide-by-zero)
	bands_to_process = min(data_band_count, 3)  # Only RGB/display bands
	if compress_arg == 'JPEG' and bands_to_process < 3:
		logger.info(
			'Converting JPEG compression to DEFLATE for low-band byte conversion',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		compress_arg = 'DEFLATE'
	if data_band_count > 3:
		logger.info(
			f'File has {data_band_count} data bands, will only process first 3 for standardization',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)

	translate_cmd = ['gdal_translate', '-ot', 'Byte']

	# Select only data/display bands when the source has extra or alpha bands.
	if source_has_alpha or data_band_count > 3:
		for band_index in range(1, bands_to_process + 1):
			translate_cmd.extend(['-b', str(band_index)])

	# Determine what nodata value to preserve in the output
	final_nodata_value = None
	source_nodata_value = None

	if explicit_nodata is not None and np.isnan(explicit_nodata):
		# NaN nodata - convert to 0 (since Byte format can't store NaN)
		logger.info(
			'Converting NaN nodata to 0 (Byte format limitation)',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		translate_cmd.extend(['-a_nodata', '0'])
		final_nodata_value = 0
		source_nodata_value = 'nan'
	elif detected_nodata == 'nan':
		# Detected NaN nodata - convert to 0
		logger.info(
			'Converting detected NaN nodata to 0 (Byte format limitation)',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		translate_cmd.extend(['-a_nodata', '0'])
		final_nodata_value = 0
		source_nodata_value = 'nan'
	elif explicit_nodata is not None:
		# Convert numeric source nodata to byte-safe nodata.
		nodata_float = float(explicit_nodata)
		logger.info(
			f'Converting explicit nodata value {nodata_float:g} to byte nodata value 0',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		translate_cmd.extend(['-a_nodata', '0'])
		final_nodata_value = 0
		source_nodata_value = nodata_float
	elif detected_nodata is not None and detected_nodata != 'nan':
		# Convert detected numeric source nodata to byte-safe nodata.
		try:
			nodata_float = float(detected_nodata)
			if not _is_plausible_detected_nodata(nodata_float, src_dtype):
				logger.warning(
					f'Ignoring implausible detected nodata value: {nodata_float:g}',
					LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
				)
			else:
				logger.info(
					f'Converting detected nodata value {nodata_float:g} to byte nodata value 0',
					LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
				)
				translate_cmd.extend(['-a_nodata', '0'])
				final_nodata_value = 0
				source_nodata_value = nodata_float
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

	# Add per-band scaling for RGB bands only
	# GDAL supports -scale_X for band-specific scaling
	for band_idx, (band_min, band_max) in enumerate(band_ranges[:bands_to_process], start=1):
		# Handle edge case where band has constant value (min == max)
		if band_min == band_max:
			logger.warning(
				f'Band {band_idx} has constant value ({band_min}), using fallback scaling',
				LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
			)
			# Use full range scaling as fallback
			translate_cmd.extend([f'-scale_{band_idx}', '0', '65535', '0', '255'])
		else:
			translate_cmd.extend([f'-scale_{band_idx}', str(band_min), str(band_max), '0', '255'])

	# Add compression - preserve original compression format if specified
	translate_cmd.extend(['-co', f'COMPRESS={compress_arg}'])
	if compress_arg == 'DEFLATE':
		translate_cmd.extend(['-co', 'PREDICTOR=2'])  # Only for DEFLATE
	translate_cmd.extend(['-co', 'TILED=YES'])  # Ensure tiled output

	translate_cmd.extend([input_path, temp_output])

	try:
		logger.info(
			'Running gdal_translate with per-band scaling: ' + ' '.join(translate_cmd),
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={
					'command': ' '.join(translate_cmd),
					'final_nodata': final_nodata_value,
					'num_bands': len(band_ranges),
				},
			),
		)
		result = subprocess.run(translate_cmd, check=True, capture_output=True, text=True)
		logger.info(
			f'gdal_translate output:\n{result.stdout}',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		try:
			processed_output = _add_alpha_from_source_nodata(
				input_path,
				temp_output,
				source_nodata_value,
				bands_to_process,
				source_alpha_band_index=source_alpha_band_index,
				token=token,
				dataset_id=dataset_id,
				user_id=user_id,
			)
		except Exception as e:
			for partial_path in [temp_output, f'{temp_output}.alpha.tif']:
				partial = Path(partial_path)
				if partial.exists():
					partial.unlink()
			logger.error(
				f'Error creating alpha band from source nodata: {e}',
				LogContext(
					category=LogCategory.ORTHO,
					dataset_id=dataset_id,
					user_id=user_id,
					token=token,
					extra={'error': str(e)},
				),
			)
			return None, None
		if processed_output != temp_output:
			return processed_output, None
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
	has_alpha: bool,  # Whether the input already has an alpha band
	compression: str,  # Original compression to preserve
	token: str,
	dataset_id: int = None,
	user_id: str = None,
) -> bool:
	"""
	Apply final transformations using gdalwarp.

	Properly handles existing alpha bands to avoid conflicting instructions:
	- If file has alpha band: Preserve all 4 bands, don't add -dstalpha
	- If file has no alpha: Extract RGB and create alpha from nodata
	- Preserves original compression format (especially important for lossy formats like WEBP, JPEG)

	JPEG YCbCr Special Handling:
	- JPEG with YCbCr photometric is incompatible with alpha band operations
	- When alpha band creation is needed, converts to DEFLATE RGB instead
	"""
	# Determine compression to use - preserve original if specified
	# CRITICAL: JPEG YCbCr is incompatible with alpha band modifications
	# If we need to create alpha from nodata, use DEFLATE instead
	if compression == 'JPEG' and (has_alpha or final_nodata_value is not None or num_bands < 3):
		logger.info(
			'Converting JPEG compression to DEFLATE for final warp (JPEG YCbCr incompatible with alpha/low-band output)',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		# JPEG-in-GTiff is unsafe for alpha and low-band outputs; accept larger
		# standardized files here to keep browser masks and grayscale data valid.
		compress_arg = 'DEFLATE'
	else:
		compress_arg = compression if compression else 'DEFLATE'

	cmd = [
		'gdalwarp',
		'-of',
		'GTiff',
		'-co',
		'TILED=YES',
		'-co',
		f'COMPRESS={compress_arg}',
	]

	# Add PREDICTOR only for DEFLATE compression
	if compress_arg == 'DEFLATE':
		cmd.extend(['-co', 'PREDICTOR=2'])

	cmd.extend(
		[
			'-co',
			'BIGTIFF=YES',
			'--config',
			'GDAL_TIFF_INTERNAL_MASK',
			'YES',
			'--config',
			'GDAL_NUM_THREADS',
			'ALL_CPUS',
		]
	)

	logger.info(
		f'Applying final transformations with {compress_arg} compression',
		LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
	)

	# CRITICAL FIX: Properly handle existing alpha bands
	if has_alpha:
		# File already has alpha band - preserve all 4 bands without conflicts
		logger.info(
			f'Input has existing alpha band, preserving all {num_bands} bands without modification',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)
		# Don't add -b flags (use all bands)
		# Don't add -dstalpha (already has alpha)
	else:
		# File doesn't have alpha band - create from nodata
		if final_nodata_value is not None:
			logger.info(
				f'Creating alpha channel for transparency (using nodata: {final_nodata_value})',
				LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
			)
			cmd.extend(['-srcnodata', str(final_nodata_value), '-dstalpha'])
		else:
			logger.info(
				'No nodata handling needed',
				LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
			)

		# Handle band selection for RGB (only if no alpha)
		if num_bands > 3:
			logger.info(
				f'Selecting first 3 bands from {num_bands} total bands',
				LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
			)
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
				extra={'command': ' '.join(cmd), 'has_alpha': has_alpha, 'num_bands': num_bands},
			),
		)
		result = subprocess.run(cmd, check=True, capture_output=True, text=True)
		logger.info(
			f'gdalwarp output:\n{result.stdout}',
			LogContext(category=LogCategory.ORTHO, dataset_id=dataset_id, user_id=user_id, token=token),
		)

		return verify_geotiff(output_path, token, dataset_id, user_id)
	except subprocess.CalledProcessError as e:
		stderr_output = e.stderr if e.stderr else 'No stderr captured'
		logger.error(
			f'Error in final transformation: {e}',
			LogContext(
				category=LogCategory.ORTHO,
				dataset_id=dataset_id,
				user_id=user_id,
				token=token,
				extra={
					'error': str(e),
					'exit_code': e.returncode,
					'stderr': stderr_output,
					'stdout': e.stdout if e.stdout else 'No stdout',
					'command': ' '.join(cmd),
				},
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
