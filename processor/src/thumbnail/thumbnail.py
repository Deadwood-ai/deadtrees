import rasterio
from rasterio.enums import Resampling
import numpy as np
from PIL import Image

from shared.logger import logger


def calculate_thumbnail(tiff_file_path: str, thumbnail_file_path: str, size=(256, 256)):
	"""
	Creates a thumbnail from a GeoTIFF file using rasterio.

	Args:
	    tiff_file_path (str): Path to the TIFF file
	    thumbnail_file_path (str): Path to save the thumbnail
	    size (tuple): Target size for thumbnail (width, height). Default is (256, 256)

	Returns:
	    None
	"""
	logger.info(f'Starting thumbnail calculation with paths - input: {tiff_file_path}, output: {thumbnail_file_path}')

	try:
		with rasterio.open(tiff_file_path) as src:
			# Calculate scaling factor
			scale_factor = min(size[0] / src.width, size[1] / src.height)

			# Calculate new dimensions (maintaining aspect ratio)
			out_width = int(src.width * scale_factor)
			out_height = int(src.height * scale_factor)

			# Read all bands including alpha
			data = src.read(out_shape=(src.count, out_height, out_width), resampling=Resampling.lanczos)

			# Create RGB array
			rgb_array = data[:3]  # First 3 bands are RGB

			# Get alpha band (4th band) if it exists, otherwise use mask
			if src.count == 4:
				alpha = data[3]
			else:
				alpha = src.read_masks(1, out_shape=(out_height, out_width), resampling=Resampling.lanczos)

			# Create white background where alpha is 0
			for band in rgb_array:
				band[alpha == 0] = 255

			# Stack bands for PIL
			rgb_array = np.dstack(rgb_array)

			# Create PIL image
			img = Image.fromarray(rgb_array)

			# Create a new image with white background
			thumb = Image.new('RGB', size, (255, 255, 255))

			# Calculate position to center the image
			offset = ((size[0] - out_width) // 2, (size[1] - out_height) // 2)

			# Paste the thumbnail onto the white background
			thumb.paste(img, offset)

			# Save the thumbnail
			logger.info(f'Saving thumbnail to: {thumbnail_file_path}')
			thumb.save(thumbnail_file_path, 'JPEG', quality=85)
			logger.info(f'Thumbnail saved successfully to: {thumbnail_file_path}')

	except Exception as e:
		logger.error(
			f'Error creating thumbnail: {str(e)}',
			extra={'tiff_file': tiff_file_path, 'thumbnail_file': thumbnail_file_path},
		)
		raise


def calculate_thumbnail_from_cog(cog_file_path: str, thumbnail_file_path: str, size=(256, 256)):
	"""
	Creates a thumbnail from a Cloud Optimized GeoTIFF (COG) file using overviews.

	Args:
		cog_file_path (str): Path to the COG file
		thumbnail_file_path (str): Path to save the thumbnail
		size (tuple): Target size for thumbnail (width, height). Default is (256, 256)

	Returns:
		None
	"""
	logger.info(f'Starting thumbnail calculation from COG - input: {cog_file_path}, output: {thumbnail_file_path}')

	try:
		# First open the file to check available overviews
		with rasterio.open(cog_file_path) as src:
			# Get list of available overviews for the first band
			overview_factors = src.overviews(1)

			if not overview_factors:
				logger.warning('No overviews found in COG file, using base resolution')
				# If no overviews, just read from the base image
				data = src.read(out_shape=(src.count, size[1], size[0]), resampling=Resampling.lanczos)

				# Get alpha band or mask
				if src.count >= 4:
					alpha = data[3]
				else:
					alpha = src.read_masks(1, out_shape=(size[1], size[0]), resampling=Resampling.lanczos)
			else:
				logger.info(f'Available overviews: {overview_factors}')
				# Choose the most appropriate overview factor
				# Start with the largest (smallest factor)
				for i, factor in enumerate(overview_factors):
					overview_width = src.width // factor
					overview_height = src.height // factor
					logger.info(f'Overview factor {factor}: {overview_width}x{overview_height}')

					# If this overview becomes too small, use the previous one
					if overview_width < size[0] or overview_height < size[1]:
						if i > 0:
							chosen_factor = overview_factors[i - 1]
						else:
							chosen_factor = overview_factors[0]
						break
				else:
					# If we didn't break, use the smallest overview (largest factor)
					chosen_factor = overview_factors[-1]

				# Find the index of the chosen factor
				overview_idx = overview_factors.index(chosen_factor)
				logger.info(f'Using overview factor: {chosen_factor} (index: {overview_idx})')

				# Open the file again with the specific overview level
				with rasterio.open(cog_file_path, overview_level=overview_idx) as ovr_src:
					# Read the data at that overview level, resampling to exact size
					data = ovr_src.read(out_shape=(ovr_src.count, size[1], size[0]), resampling=Resampling.lanczos)

					# Get alpha band or mask at that overview level
					if ovr_src.count >= 4:
						alpha = data[3]
					else:
						alpha = ovr_src.read_masks(1, out_shape=(size[1], size[0]), resampling=Resampling.lanczos)

			# Create RGB array (first 3 bands)
			rgb_array = data[:3] if data.shape[0] >= 3 else np.tile(data[0:1], (3, 1, 1))

			# Create white background where alpha is 0
			for band in rgb_array:
				band[alpha == 0] = 255

			# Stack bands for PIL
			rgb_array = np.transpose(rgb_array, (1, 2, 0))

			# Ensure values are in valid range for uint8
			rgb_array = np.clip(rgb_array, 0, 255).astype(np.uint8)

			# Create PIL image
			img = Image.fromarray(rgb_array)

			# Save the thumbnail
			logger.info(f'Saving thumbnail to: {thumbnail_file_path}')
			img.save(thumbnail_file_path, 'JPEG', quality=85)
			logger.info(f'Thumbnail from COG saved successfully to: {thumbnail_file_path}')

	except Exception as e:
		logger.error(
			f'Error creating thumbnail from COG: {str(e)}',
			extra={'cog_file': cog_file_path, 'thumbnail_file': thumbnail_file_path},
		)
		raise
