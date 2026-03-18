from pathlib import Path
import subprocess
import rasterio
from shared.logger import logger
from rio_cogeo.cogeo import cog_info, cog_validate
# from rio_cogeo.profiles import cog_profiles

def _build_cog_translate_command(
	tiff_file_path: str,
	cog_target_path: str,
	num_bands: int,
	force_epsg_3857: bool = False,
):
	"""Build gdal_translate command with a safe strategy per band-count."""
	if num_bands < 1:
		raise ValueError(f'Invalid band count: {num_bands}')

	compress = 'JPEG'
	overview_compress = 'JPEG'
	add_alpha = False
	band_indexes = None

	if num_bands == 1:
		# Grayscale input. Keep JPEG but pin explicit band.
		band_indexes = [1]
	elif num_bands == 2:
		# JPEG does not consistently handle 2-band rasters.
		# Use lossless DEFLATE and preserve both bands.
		compress = 'DEFLATE'
		overview_compress = 'DEFLATE'
		band_indexes = [1, 2]
	elif num_bands == 3:
		# Existing behavior for RGB data.
		add_alpha = True
	else:
		# Avoid the RGBA+JPEG+ALPHA path which failed in production.
		# We keep RGB output by selecting the first 3 bands.
		band_indexes = [1, 2, 3]

	cmd_translate = ['gdal_translate', tiff_file_path]

	if band_indexes:
		for band_index in band_indexes:
			cmd_translate.extend(['-b', str(band_index)])

	cmd_translate.extend(
		[
			cog_target_path,
			'-co',
			'BIGTIFF=YES',
			'-ot',
			'Byte',
			'-of',
			'COG',
			'-co',
			f'COMPRESS={compress}',
			'-co',
			'QUALITY=95',
			'-co',
			f'OVERVIEW_COMPRESS={overview_compress}',
			'-co',
			'OVERVIEW_QUALITY=95',
			'-co',
			'TILING_SCHEME=GoogleMapsCompatible',
			'--config',
			'GDAL_TIFF_INTERNAL_MASK',
			'TRUE',
			'--config',
			'GDAL_NUM_THREADS',
			'ALL_CPUS',
			'--config',
			'GDAL_CACHEMAX',
			'32768',
			'--config',
			'GDAL_GTIFF_SRS_SOURCE',
			'EPSG',
		]
	)

	if add_alpha:
		cmd_translate.extend(['-co', 'ALPHA=YES'])

	if force_epsg_3857:
		cmd_translate.extend(['-a_srs', 'EPSG:3857'])

	return cmd_translate


def _run_gdal_translate(command: list[str], token: str | None = None, attempt: str = 'primary'):
	"""Run gdal_translate and log full stdout/stderr on success/failure."""
	try:
		result = subprocess.run(command, check=True, capture_output=True, text=True)
		if result.stdout:
			logger.info(f'gdal_translate stdout ({attempt}):\n{result.stdout}', extra={'token': token})
		if result.stderr:
			logger.info(f'gdal_translate stderr ({attempt}):\n{result.stderr}', extra={'token': token})
	except subprocess.CalledProcessError as e:
		logger.error(
			(
				f'gdal_translate failed ({attempt}) exit_code={e.returncode}\n'
				f'command: {" ".join(command)}\n'
				f'stdout:\n{e.stdout or ""}\n'
				f'stderr:\n{e.stderr or ""}'
			),
			extra={'token': token},
		)
		raise


# def calculate_cog(
# 	tiff_file_path: str,
# 	cog_target_path: str,
# 	profile='webp',
# 	quality=75,
# 	skip_recreate: bool = False,
# 	tiling_scheme='web-optimized',
# 	token: str = None,
# ):
# 	"""Function to initiate the cog calculation process.

# 	Args:
# 	    tiff_file_path (str): Path to the geotiff file to be processed
# 	    cog_target_path (str): Path for the finished cog file to save to
# 	    profile (str, optional): Optional base compression profile for the cog calculation. Defaults to "webp".
# 	    overviews (int, optional): Optional overview number. Defaults to None.
# 	    quality (int, optional): Optional overall quality setting (between 0 and 100). Defaults to 75.
# 	    skip_recreate (bool, optional): Option to skip recreate. Defaults to False.

# 	Returns:
# 	    Function: Returns the cog calculation function the initialized settings
# 	"""
# 	# we use the gdal
# 	return _gdal_calculate_cog(
# 		tiff_file_path, cog_target_path, compress=profile, overviews=None, quality=quality, skip_recreate=skip_recreate
# 	)
# 	# return _rio_calculate_cog(tiff_file_path, cog_target_path, profile=profile, quality=quality, skip_recreate=skip_recreate, tiling_scheme="web-optimized")


def calculate_cog(
	tiff_file_path: str,
	cog_target_path: str,
	skip_recreate: bool = False,
	token: str = None,
):
	"""Function to calculate a Cloud Optimized Geotiff (cog) from a geotiff using gdal.

	Args:
	    tiff_file_path (str): Path to the geotiff file to be processed
	    cog_target_path (str): Path for the finished cog file to save to
	    skip_recreate (bool, optional): Option to skip recreate. Defaults to False.
	    token (str, optional): Optional token for logging. Defaults to None.

	Returns:
	    Info: Returns general infos and validation for the calculated Cloud Optimized Geotiff
	"""
	# check if the COG already exists
	if skip_recreate and Path(cog_target_path).exists():
		return cog_info(cog_target_path)

	# Get number of bands from input file
	with rasterio.open(tiff_file_path) as src:
		num_bands = src.count

	cmd_translate = _build_cog_translate_command(
		tiff_file_path=tiff_file_path,
		cog_target_path=cog_target_path,
		num_bands=num_bands,
	)

	# Try to process with original CRS first
	try:
		logger.info(
			f'Running COG processing with original CRS (bands={num_bands})',
			extra={'token': token},
		)
		_run_gdal_translate(cmd_translate, token=token, attempt='original-crs')
	except subprocess.CalledProcessError:
		logger.info('Retrying COG processing with EPSG:3857', extra={'token': token})
		try:
			cmd_translate_epsg = _build_cog_translate_command(
				tiff_file_path=tiff_file_path,
				cog_target_path=cog_target_path,
				num_bands=num_bands,
				force_epsg_3857=True,
			)
			_run_gdal_translate(cmd_translate_epsg, token=token, attempt='epsg-3857-retry')
		except subprocess.CalledProcessError as e:
			logger.error(f'Error running gdal_translate with EPSG:3857 retry: {e}', extra={'token': token})
			raise  # Re-raise the exception to stop execution if both attempts fail

	return cog_info(cog_target_path)


# def _rio_calculate_cog(
# 	tiff_file_path,
# 	cog_target_path,
# 	profile='webp',
# 	quality=75,
# 	skip_recreate: bool = False,
# 	tiling_scheme='web-optimized',
# ):
# 	"""
# 	Converts a TIFF file to a Cloud Optimized GeoTIFF (COG) format using the specified profile and configuration.

# 	Args:
# 	    tiff_file_path (str): Path to the input TIFF file.
# 	    cog_target_path (str): Path where the output COG file will be saved.
# 	    profile (str, optional): COG profile to use. Default is "webp".
# 	                             Available profiles: "jpeg", "webp", "zstd", "lzw", "deflate", "packbits", "lzma",
# 	                             "lerc", "lerc_deflate", "lerc_zstd", "raw".
# 	    tiling_scheme (str, optional): Tiling scheme to use. Default is "web-optimized".
# 	    skip_recreate (bool, optional): If True, skips recreating the COG if it already exists. Default is False.

# 	Returns:
# 	    dict: Information about the generated COG file.

# 	Raises:
# 	    RuntimeError: If COG validation fails.

# 	Notes:
# 	    - The function uses the `cog_translate` function from the rio_cogeo library to perform the conversion.
# 	    - The output COG is validated using the `cog_validate` function.
# 	    - If validation fails, a RuntimeError is raised.
# 	    - The function returns information about the COG using the `cog_info` function.

# 	Example:
# 	    >>> calculate_cog("input.tif", "output.cog.tif", profile="jpeg")

# 	"""
# 	# check if the COG already exists
# 	if skip_recreate and Path(cog_target_path).exists():
# 		return cog_info(cog_target_path)

# 	# get the output profile
# 	output_profile = cog_profiles.get(profile)

# 	# set the GDAL options directly:
# 	config = dict(
# 		# GDAL_NUM_THREADS="ALL_CPUS",
# 		GDAL_NUM_THREADS='2',
# 		GDAL_TIFF_INTERNAL_MASK=True,
# 		# GDAL_TIFF_OVR_BLOCKSIZE=f"{blocksize}",
# 	)

# 	if quality is not None:
# 		output_profile.update(dict(quality=quality))

# 	# set web optimized
# 	if tiling_scheme == 'web-optimized':
# 		web_optimized = True
# 	else:
# 		web_optimized = False

# 	# run
# 	cog_translate(
# 		tiff_file_path,
# 		cog_target_path,
# 		output_profile,
# 		config=config,
# 		web_optimized=web_optimized,
# 		# overview_level=overviews,
# 		# indexes=(1, 2, 3),
# 		# add_mask=True,
# 		use_cog_driver=True,
# 	)

# 	if not validate(cog_target_path):
# 		# check if the cog is valid
# 		raise RuntimeError(f'Validation failed for {cog_target_path}')

# 	# return info
# 	return cog_info(cog_target_path)


def validate(cog_path):
	"""
	Validate a COG file.

	Args:
	    cog_path (str): Path to the COG file.

	Returns:
	    bool: True if the COG is valid, False otherwise.

	"""
	return cog_validate(cog_path)
