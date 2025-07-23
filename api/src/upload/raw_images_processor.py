"""Simplified ZIP upload processing - focuses on extraction and storage only"""

import zipfile
from pathlib import Path
from typing import List, Dict, Any
from shared.models import Dataset, RawImages
from shared.status import update_status
from shared.models import StatusEnum
from shared.settings import settings
from shared.db import use_client
from .rtk_utils import detect_rtk_files, parse_rtk_timestamp_file


async def process_raw_images_upload(dataset: Dataset, upload_target_path: Path, token: str) -> Dataset:
	"""Process ZIP upload with simplified logic - extract and store only, no technical analysis

	Args:
		dataset: The dataset object created during upload
		upload_target_path: Path to the uploaded ZIP file
		token: Authentication token for database operations

	Returns:
		Dataset: The updated dataset object

	Note:
		This function only handles file extraction and basic storage. All technical analysis
		is deferred to the ODM and geotiff processing tasks.
	"""
	# Create extraction directory
	extraction_dir = settings.raw_images_path / str(dataset.id)
	extraction_dir.mkdir(parents=True, exist_ok=True)

	# Extract ZIP contents
	with zipfile.ZipFile(upload_target_path, 'r') as zip_ref:
		zip_ref.extractall(extraction_dir)

	# Get list of extracted files
	extracted_files = []
	total_size_bytes = 0
	for file_path in extraction_dir.rglob('*'):
		if file_path.is_file():
			relative_path = file_path.relative_to(extraction_dir)
			extracted_files.append(str(relative_path))
			total_size_bytes += file_path.stat().st_size

	# Count image files (basic image extensions)
	image_extensions = {'.jpg', '.jpeg', '.png', '.tif', '.tiff', '.dng', '.raw'}
	image_files = [f for f in extracted_files if Path(f).suffix.lower() in image_extensions]

	# Detect RTK files and parse basic metadata
	rtk_metadata = detect_rtk_files(extracted_files)

	# Parse RTK timestamp data if available
	rtk_precision_cm = None
	rtk_quality_indicator = None
	if rtk_metadata.get('has_rtk_data'):
		mrk_files = [f for f in extracted_files if f.upper().endswith('.MRK')]
		if mrk_files:
			mrk_path = extraction_dir / mrk_files[0]
			rtk_timestamp_data = parse_rtk_timestamp_file(mrk_path)
			# Set basic RTK defaults (simplified for upload phase)
			if rtk_timestamp_data.get('rtk_timestamp_available'):
				rtk_precision_cm = 2.0  # Typical RTK precision in cm
				rtk_quality_indicator = 5  # Quality indicator

	# Create raw_images database entry matching actual table schema
	raw_images_data = {
		'dataset_id': dataset.id,
		'raw_image_count': len(image_files),
		'raw_image_size_mb': max(1, total_size_bytes // (1024 * 1024)),  # Convert to MB, minimum 1
		'raw_images_path': str(extraction_dir),
		'camera_metadata': {},  # Basic placeholder for now
		'has_rtk_data': rtk_metadata.get('has_rtk_data', False),
		'rtk_precision_cm': rtk_precision_cm,
		'rtk_quality_indicator': rtk_quality_indicator,
		'rtk_file_count': rtk_metadata.get('rtk_file_count', 0),
		'version': 1,
	}

	# Insert raw_images entry into database
	with use_client(token) as client:
		response = client.table(settings.raw_images_table).insert(raw_images_data).execute()

	# Clean up uploaded ZIP file
	upload_target_path.unlink()

	# Update status to indicate upload completion only
	update_status(
		token=token,
		dataset_id=dataset.id,
		current_status=StatusEnum.idle,
		is_upload_done=True,
		has_error=False,
	)

	return dataset
