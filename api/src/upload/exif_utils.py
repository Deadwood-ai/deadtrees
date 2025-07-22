"""
EXIF data extraction utilities for drone images.

This module provides functions to extract EXIF metadata from drone images,
with particular focus on acquisition date and comprehensive metadata extraction.
"""

from pathlib import Path
from typing import Dict, Any, Optional
from datetime import datetime

try:
	from PIL import Image
	from PIL.ExifTags import TAGS
except ImportError:
	Image = None
	TAGS = None

from shared.logging import LogCategory, LogContext, UnifiedLogger, SupabaseHandler

# Create logger instance
logger = UnifiedLogger(__name__)
logger.add_supabase_handler(SupabaseHandler())


def extract_comprehensive_exif(image_path: Path) -> Dict[str, Any]:
	"""
	Extract comprehensive EXIF metadata from an image file.

	Args:
	    image_path: Path to the image file

	Returns:
	    Dictionary containing EXIF metadata with human-readable tag names
	    Returns empty dict if extraction fails or no EXIF data available
	"""
	if Image is None:
		logger.warning('PIL/Pillow not available - EXIF extraction disabled', LogContext(category=LogCategory.UPLOAD))
		return {}

	try:
		with Image.open(image_path) as img:
			exif_data = img._getexif()

			if exif_data is None:
				logger.debug(f'No EXIF data found in image: {image_path}', LogContext(category=LogCategory.UPLOAD))
				return {}

			# Convert numeric EXIF tags to human-readable names
			exif_dict = {}
			for tag_id, value in exif_data.items():
				tag_name = TAGS.get(tag_id, tag_id)

				# Handle special cases where values might be tuples or need conversion
				if isinstance(value, tuple) and len(value) == 2:
					# GPS coordinates and ratios are often stored as tuples
					try:
						exif_dict[tag_name] = float(value[0]) / float(value[1]) if value[1] != 0 else 0
					except (ValueError, TypeError):
						exif_dict[tag_name] = str(value)
				elif isinstance(value, bytes):
					# Handle byte strings
					try:
						exif_dict[tag_name] = value.decode('utf-8', errors='ignore')
					except AttributeError:
						exif_dict[tag_name] = str(value)
				else:
					exif_dict[tag_name] = value

			logger.debug(
				f'Extracted {len(exif_dict)} EXIF tags from {image_path}', LogContext(category=LogCategory.UPLOAD)
			)

			return exif_dict

	except Exception as e:
		logger.error(
			f'Failed to extract EXIF data from {image_path}: {str(e)}', LogContext(category=LogCategory.UPLOAD)
		)
		return {}


def extract_acquisition_date(image_path: Path) -> Optional[datetime]:
	"""
	Extract the acquisition date from image EXIF data.

	Attempts to find date/time information from various EXIF fields in order of preference:
	1. DateTime (when photo was taken)
	2. DateTimeOriginal (original photo date/time)
	3. DateTimeDigitized (when photo was digitized)

	Args:
	    image_path: Path to the image file

	Returns:
	    datetime object if acquisition date found, None otherwise
	"""
	exif_data = extract_comprehensive_exif(image_path)

	if not exif_data:
		return None

	# List of EXIF fields to check for date/time, in order of preference
	datetime_fields = [
		'DateTime',  # Most common field for when photo was taken
		'DateTimeOriginal',  # Original photo date/time
		'DateTimeDigitized',  # When photo was digitized
	]

	for field in datetime_fields:
		if field in exif_data:
			date_string = exif_data[field]

			try:
				# EXIF datetime format is typically "YYYY:MM:DD HH:MM:SS"
				if isinstance(date_string, str):
					# Replace colons in date part with hyphens for proper parsing
					normalized_date = date_string.replace(':', '-', 2)
					# Try parsing with different formats
					for fmt in ['%Y-%m-%d %H:%M:%S', '%Y:%m:%d %H:%M:%S']:
						try:
							acquisition_date = datetime.strptime(date_string, fmt)
							logger.debug(
								f'Extracted acquisition date from {field}: {acquisition_date}',
								LogContext(category=LogCategory.UPLOAD),
							)
							return acquisition_date
						except ValueError:
							continue

			except Exception as e:
				logger.warning(
					f"Failed to parse date from {field} field '{date_string}': {str(e)}",
					LogContext(category=LogCategory.UPLOAD),
				)
				continue

	logger.debug(f'No acquisition date found in EXIF data for {image_path}', LogContext(category=LogCategory.UPLOAD))
	return None
