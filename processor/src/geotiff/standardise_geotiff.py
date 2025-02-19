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
	Standardise a GeoTIFF so that:
	  - It is converted to 8-bit if needed (with scaling),
	  - A true alpha channel is created using internal TIFF masks
	  - Nodata values are properly handled with transparency
	"""
	try:
		# Open source to read metadata and determine nodata
		with rasterio.open(input_path) as src:
			src_dtype = src.profile['dtype']
			num_bands = src.count
			src_crs = src.crs

			# Determine nodata value (default to 0 if none detected)
			current_nodata = find_nodata_value(src, num_bands)
			# if current_nodata is None:
			# current_nodata = 0
			logger.info(f'Detected current nodata value: {current_nodata}', extra={'token': token})

			# Compute statistics if not uint8
			if src_dtype != 'uint8':
				stats = []
				for i in range(1, min(num_bands, 4)):  # Only process up to 3 bands (RGB)
					band = src.read(i)
					if current_nodata is not None:
						band = band[band != current_nodata]
					if band.size > 0:
						min_val = band.min()
						max_val = band.max()
					else:
						min_val = 0
						max_val = 255
					stats.append((min_val, max_val))
				logger.info(f'Band statistics: {stats}', extra={'token': token})

			if not src_crs:
				logger.warning('No CRS found in source file', extra={'token': token})
				return False

		# Base command using gdalwarp for better handling of alpha channel
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
		if current_nodata is not None:
			cmd.extend(['-srcnodata', str(current_nodata)])
			cmd.extend(['-dstnodata', '0'])  # Set output nodata to 0
			cmd.extend(['-dstalpha'])  # Create a true alpha band

		# Add scaling and data type conversion if not uint8
		if src_dtype != 'uint8':
			cmd.extend(['-ot', 'Byte'])
			# cmd.extend(['-scale'])
			for i, (min_val, max_val) in enumerate(stats, 1):
				if min_val != max_val:  # Avoid division by zero in scaling
					cmd.extend(['-scale_' + str(i), str(min_val), str(max_val), '1', '255'])

		# Handle band selection based on number of bands
		if num_bands > 3:
			# Select first three bands for RGB
			cmd.extend(['-b', '1', '-b', '2', '-b', '3'])

		# Add input and output paths
		cmd.extend([input_path, output_path])

		logger.info('Running gdalwarp conversion: ' + ' '.join(cmd), extra={'token': token})
		result = subprocess.run(cmd, check=True, capture_output=True, text=True)
		logger.info(f'gdalwarp output:\n{result.stdout}', extra={'token': token})

		# Verify the output
		if not verify_geotiff(output_path, token):
			logger.error('Output file verification failed', extra={'token': token})
			return False

		return True

	except subprocess.CalledProcessError as e:
		logger.error(f'Error during gdalwarp conversion: {e}', extra={'token': token})
		return False
	except Exception as e:
		logger.error(f'Unexpected error: {e}', extra={'token': token})
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
