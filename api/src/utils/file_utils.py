"""File utility functions for upload processing"""

from pathlib import Path
from enum import Enum
from fastapi import HTTPException


class UploadType(Enum):
	"""Supported upload file types"""

	GEOTIFF = 'geotiff'
	RAW_IMAGES_ZIP = 'raw_images_zip'


def detect_upload_type(file_name: str) -> UploadType:
	"""Detect upload type based on file extension

	Args:
		file_name (str): The name of the uploaded file

	Returns:
		UploadType: The detected upload type

	Raises:
		HTTPException: If file type is not supported
	"""
	file_path = Path(file_name)
	extension = file_path.suffix.lower()

	if extension in ['.tif', '.tiff']:
		return UploadType.GEOTIFF
	elif extension == '.zip':
		return UploadType.RAW_IMAGES_ZIP
	else:
		raise HTTPException(
			status_code=400, detail=f'Unsupported file type: {extension}. Supported types: .tif, .tiff, .zip'
		)
