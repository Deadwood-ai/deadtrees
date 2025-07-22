import zipfile
import shutil
from pathlib import Path
from typing import List, Optional, Dict, Any
from datetime import datetime

from fastapi import HTTPException, UploadFile

from shared.models import Dataset, RawImages, LicenseEnum, PlatformEnum, DatasetAccessEnum
from shared.db import use_client
from shared.settings import settings
from shared.logging import LogCategory, LogContext, UnifiedLogger, SupabaseHandler

# Create logger instance
logger = UnifiedLogger(__name__)
logger.add_supabase_handler(SupabaseHandler())


async def process_raw_images_upload(
	user_id: str,
	file_path: Path,
	file_name: str,
	license: LicenseEnum,
	platform: PlatformEnum,
	authors: List[str],
	project_id: Optional[str] = None,
	aquisition_year: Optional[int] = None,
	aquisition_month: Optional[int] = None,
	aquisition_day: Optional[int] = None,
	additional_information: Optional[str] = None,
	data_access: DatasetAccessEnum = DatasetAccessEnum.public,
	citation_doi: Optional[str] = None,
	token: str = None,
) -> Dataset:
	"""Process raw drone images ZIP upload

	Args:
		user_id: User ID who uploaded the file
		file_path: Path to the uploaded ZIP file
		file_name: Original filename
		license: Dataset license
		platform: Platform type
		authors: List of authors
		project_id: Optional project ID
		aquisition_year: Acquisition year
		aquisition_month: Acquisition month
		aquisition_day: Acquisition day
		additional_information: Additional information
		data_access: Data access level
		citation_doi: Citation DOI
		token: Authentication token

	Returns:
		Dataset: Created dataset entry

	Raises:
		HTTPException: If processing fails
	"""
	logger.info(
		f'Starting raw images upload processing for {file_name}',
		LogContext(
			category=LogCategory.UPLOAD,
			user_id=user_id,
			token=token,
			extra={'file_name': file_name, 'file_size': file_path.stat().st_size},
		),
	)

	try:
		# Create dataset entry first
		dataset = _create_dataset_entry(
			user_id=user_id,
			file_name=file_name,
			license=license,
			platform=platform,
			authors=authors,
			project_id=project_id,
			aquisition_year=aquisition_year,
			aquisition_month=aquisition_month,
			aquisition_day=aquisition_day,
			additional_information=additional_information,
			data_access=data_access,
			citation_doi=citation_doi,
			token=token,
		)

		# Extract and validate ZIP file using dataset ID
		zip_info = _extract_and_validate_zip(file_path, dataset.id, token)

		# Extract acquisition date from EXIF if not provided
		if not aquisition_year or not aquisition_month or not aquisition_day:
			extracted_date = _extract_acquisition_date_from_images(zip_info['image_files'])
			if extracted_date:
				# Update dataset with extracted date if not provided
				logger.info(
					f'Extracted acquisition date from EXIF: {extracted_date}',
					LogContext(category=LogCategory.UPLOAD, user_id=user_id, dataset_id=dataset.id, token=token),
				)

		# Create raw images database entry
		raw_images_entry = _create_raw_images_entry(dataset_id=dataset.id, zip_info=zip_info, token=token)

		logger.info(
			f'Raw images upload processing completed for dataset {dataset.id}',
			LogContext(
				category=LogCategory.UPLOAD,
				user_id=user_id,
				dataset_id=dataset.id,
				token=token,
				extra={
					'image_count': zip_info['image_count'],
					'rtk_files': zip_info['rtk_file_count'],
					'storage_path': str(zip_info['images_dir']),
				},
			),
		)

		return dataset

	except Exception as e:
		logger.error(
			f'Error processing raw images upload: {str(e)}',
			LogContext(
				category=LogCategory.UPLOAD,
				user_id=user_id,
				token=token,
				extra={'file_name': file_name, 'error': str(e)},
			),
		)
		raise HTTPException(status_code=500, detail=f'Error processing raw images upload: {str(e)}')


def _extract_and_validate_zip(file_path: Path, dataset_id: int, token: str) -> Dict[str, Any]:
	"""Extract and validate ZIP file contents directly to storage

	Args:
		file_path: Path to ZIP file
		dataset_id: Dataset ID for storage path
		token: Authentication token

	Returns:
		Dict containing extracted file information and storage paths

	Raises:
		HTTPException: If ZIP validation fails
	"""
	try:
		# Create dataset directory structure: raw_images/{dataset_id}/
		dataset_dir = settings.raw_images_path / str(dataset_id)
		images_dir = dataset_dir / 'images'
		images_dir.mkdir(parents=True, exist_ok=True)

		# Store original ZIP file: raw_images/{dataset_id}/{dataset_id}_raw_images.zip
		zip_storage_path = dataset_dir / f'{dataset_id}_raw_images.zip'
		shutil.copy2(file_path, zip_storage_path)

		# Extract ZIP file directly to images directory
		with zipfile.ZipFile(file_path, 'r') as zip_ref:
			zip_ref.extractall(images_dir)

		# Get list of all extracted files
		all_files = list(images_dir.rglob('*'))

		# Separate image files and RTK files
		image_extensions = {'.jpg', '.jpeg', '.png', '.tif', '.tiff', '.dng', '.raw'}
		rtk_extensions = {'.rtk', '.mrk', '.rtl', '.rtb', '.rpos', '.rts', '.imu'}

		image_files = [f for f in all_files if f.is_file() and f.suffix.lower() in image_extensions]
		rtk_files = [f for f in all_files if f.is_file() and f.suffix.lower() in rtk_extensions]

		# Validate minimum requirements
		if len(image_files) < 3:
			raise HTTPException(
				status_code=400, detail=f'Minimum 3 images required for ODM processing, found {len(image_files)}'
			)

		# Calculate total size
		total_size_mb = sum(f.stat().st_size for f in image_files + rtk_files) // (1024 * 1024)

		logger.info(
			f'ZIP extracted to storage: {images_dir}',
			LogContext(
				category=LogCategory.UPLOAD,
				dataset_id=dataset_id,
				token=token,
				extra={'images_count': len(image_files), 'rtk_count': len(rtk_files), 'storage_path': str(images_dir)},
			),
		)

		return {
			'dataset_dir': dataset_dir,
			'images_dir': images_dir,
			'zip_storage_path': zip_storage_path,
			'image_files': image_files,
			'rtk_files': rtk_files,
			'image_count': len(image_files),
			'rtk_file_count': len(rtk_files),
			'total_size_mb': total_size_mb,
			'has_rtk_data': len(rtk_files) > 0,
		}

	except zipfile.BadZipFile:
		raise HTTPException(status_code=400, detail='Invalid ZIP file format')
	except Exception as e:
		raise HTTPException(status_code=500, detail=f'Error extracting ZIP file: {str(e)}')


def _create_dataset_entry(
	user_id: str,
	file_name: str,
	license: LicenseEnum,
	platform: PlatformEnum,
	authors: List[str],
	project_id: Optional[str],
	aquisition_year: Optional[int],
	aquisition_month: Optional[int],
	aquisition_day: Optional[int],
	additional_information: Optional[str],
	data_access: DatasetAccessEnum,
	citation_doi: Optional[str],
	token: str,
) -> Dataset:
	"""Create dataset entry in database

	Args:
		user_id: User ID
		file_name: Original filename
		license: Dataset license
		platform: Platform type
		authors: List of authors
		project_id: Optional project ID
		aquisition_year: Acquisition year
		aquisition_month: Acquisition month
		aquisition_day: Acquisition day
		additional_information: Additional information
		data_access: Data access level
		citation_doi: Citation DOI
		token: Authentication token

	Returns:
		Dataset: Created dataset entry
	"""
	data = {
		'user_id': user_id,
		'file_name': file_name,
		'license': license,
		'platform': platform,
		'authors': authors,
		'project_id': project_id,
		'aquisition_year': aquisition_year,
		'aquisition_month': aquisition_month,
		'aquisition_day': aquisition_day,
		'additional_information': additional_information,
		'data_access': data_access,
		'citation_doi': citation_doi,
	}

	dataset = Dataset(**data)

	with use_client(token) as client:
		try:
			send_data = {k: v for k, v in dataset.model_dump().items() if k != 'id' and v is not None}
			response = client.table(settings.datasets_table).insert(send_data).execute()
			return Dataset(**response.data[0])
		except Exception as e:
			raise HTTPException(status_code=400, detail=f'Error creating dataset entry: {str(e)}')


def _extract_acquisition_date_from_images(image_files: List[Path]) -> Optional[datetime]:
	"""Extract acquisition date from image EXIF data

	Args:
		image_files: List of image file paths

	Returns:
		Optional datetime from EXIF data
	"""
	# TODO: Implement EXIF extraction in future task (api/src/upload/exif_utils.py)
	# This is a placeholder for now
	return None


def _create_raw_images_entry(dataset_id: int, zip_info: Dict[str, Any], token: str) -> RawImages:
	"""Create raw images entry in database

	Args:
		dataset_id: Dataset ID
		zip_info: ZIP extraction information (contains storage paths)
		token: Authentication token

	Returns:
		RawImages: Created raw images entry
	"""
	# Extract RTK precision if available
	rtk_precision = None
	rtk_quality = None
	if zip_info['has_rtk_data']:
		# TODO: Parse RTK data for precision values in future task
		rtk_precision = 2.0  # Placeholder: typical RTK precision in cm
		rtk_quality = 5  # Placeholder: quality indicator

	raw_images_data = {
		'dataset_id': dataset_id,
		'raw_image_count': zip_info['image_count'],
		'raw_image_size_mb': zip_info['total_size_mb'],
		'raw_images_path': str(zip_info['images_dir']),
		'camera_metadata': {},  # TODO: Extract from EXIF in future task
		'has_rtk_data': zip_info['has_rtk_data'],
		'rtk_precision_cm': rtk_precision,
		'rtk_quality_indicator': rtk_quality,
		'rtk_file_count': zip_info['rtk_file_count'],
		'version': 1,
	}

	raw_images = RawImages(**raw_images_data)

	with use_client(token) as client:
		try:
			send_data = {
				k: v for k, v in raw_images.model_dump().items() if k not in ['id', 'created_at'] and v is not None
			}
			response = client.table('v2_raw_images').insert(send_data).execute()
			return RawImages(**response.data[0])
		except Exception as e:
			raise HTTPException(status_code=400, detail=f'Error creating raw images entry: {str(e)}')
