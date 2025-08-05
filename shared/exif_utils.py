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


def _sanitize_text_for_db(text: str) -> str:
	"""
	Sanitize text to remove characters that can't be stored in PostgreSQL.

	Args:
		text: Input text string

	Returns:
		Sanitized text safe for database storage, or empty string if no valid content
	"""
	if not text:
		return ''

	# Remove null characters and other problematic Unicode characters
	# PostgreSQL doesn't support null characters (\x00, \u0000)
	sanitized = text.replace('\x00', '').replace('\u0000', '')

	# Remove other control characters that might cause issues
	# Keep only printable characters, spaces, tabs, and newlines
	sanitized = ''.join(char for char in sanitized if char.isprintable() or char in '\t\n\r ')

	# Strip whitespace and ensure there's meaningful content
	sanitized = sanitized.strip()

	# Only return if there's actual meaningful content (not just punctuation/spaces)
	if sanitized and any(c.isalnum() for c in sanitized):
		return sanitized

	return ''


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
					# Handle byte strings - convert to string representation for JSON serialization
					try:
						# Try to decode as UTF-8 first
						decoded = value.decode('utf-8', errors='ignore')
						# Sanitize the decoded string to remove problematic characters
						sanitized = _sanitize_text_for_db(decoded)
						if sanitized:
							exif_dict[tag_name] = sanitized
						else:
							# Skip if sanitization left nothing meaningful
							continue
					except (UnicodeDecodeError, AttributeError):
						# Skip problematic byte values that can't be safely converted
						continue
				elif isinstance(value, (int, float, bool, type(None))):
					# Only include JSON-serializable primitive types (excluding str for now)
					exif_dict[tag_name] = value
				elif isinstance(value, str):
					# Handle string values with sanitization
					sanitized = _sanitize_text_for_db(value)
					if sanitized:
						exif_dict[tag_name] = sanitized
				elif hasattr(value, '__str__') and not isinstance(value, (list, dict, tuple)):
					# Convert other objects to string if they have a string representation
					# but avoid complex data structures
					try:
						str_value = str(value)
						# Sanitize and check length
						sanitized = _sanitize_text_for_db(str_value)
						if sanitized and len(sanitized) < 1000:
							exif_dict[tag_name] = sanitized
					except:
						# Skip values that can't be safely converted to string
						continue
				else:
					# Skip complex data types that might not be JSON serializable
					continue

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
