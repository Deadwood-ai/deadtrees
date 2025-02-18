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
