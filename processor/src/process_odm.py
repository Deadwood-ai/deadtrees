import zipfile
import docker
from pathlib import Path
from typing import Optional, Dict, Any

from shared.models import QueueTask
from shared.logger import logger
from shared.settings import settings
from shared.status import update_status
from shared.logging import LogContext, LogCategory
from shared.db import use_client
from processor.src.utils.ssh import pull_file_from_storage_server, push_file_to_storage_server
from processor.src.utils.shared_volume import copy_files_to_shared_volume, copy_results_from_shared_volume
from shared.exif_utils import extract_comprehensive_exif

# RTK file extensions as specified in requirements
RTK_EXTENSIONS = {'.RTK', '.MRK', '.RTL', '.RTB', '.RPOS', '.RTS', '.IMU'}


def process_odm(task: QueueTask, temp_dir: Path):
	"""
	Process ODM (OpenDroneMap) task for raw drone images.

	Steps:
	1. Query database to get actual raw_images_path (ZIP file location)
	2. Pull ZIP file from storage via SSH
	3. Extract ZIP file locally
	4. Detect RTK files and update database with metadata
	5. Extract EXIF metadata from images and update database
	6. Execute ODM Docker container using --fast-orthophoto and --crop 0.1
	7. Move generated orthomosaic to archive/{dataset_id}_ortho.tif
	8. Update status is_odm_done=True

	Uses simplified ODM configuration with --fast-orthophoto and --crop 0.1 for
	fast processing with better quality orthomosaics and cleaner boundaries.

	Args:
		task: QueueTask with dataset_id and user information
		temp_dir: Temporary directory for processing
	"""
	from shared.db import login

	dataset_id = task.dataset_id
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

	logger.info(
		f'Starting ODM processing for dataset {dataset_id}',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	try:
		# Step 1: Query database to get actual raw_images_path (ZIP file location)
		with use_client(token) as client:
			response = (
				client.table(settings.raw_images_table).select('raw_images_path').eq('dataset_id', dataset_id).execute()
			)
			if not response.data:
				raise Exception(f'No raw_images entry found for dataset {dataset_id}')

			remote_zip_path = response.data[0]['raw_images_path']
			logger.info(
				f'Found raw_images_path in database: {remote_zip_path}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)

		# Step 2: Pull ZIP file from storage
		zip_filename = f'{dataset_id}.zip'
		local_zip_path = temp_dir / zip_filename

		logger.info(
			f'Pulling ZIP file from storage: {remote_zip_path}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		pull_file_from_storage_server(
			remote_file_path=remote_zip_path, local_file_path=str(local_zip_path), token=token, dataset_id=dataset_id
		)

		# Step 3: Extract ZIP file locally
		extraction_dir = temp_dir / f'raw_images_{dataset_id}'
		extraction_dir.mkdir(exist_ok=True)

		logger.info(
			f'Extracting ZIP file to: {extraction_dir}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		with zipfile.ZipFile(local_zip_path, 'r') as zip_ref:
			zip_ref.extractall(extraction_dir)

		# Step 4: Detect RTK files and update database with comprehensive metadata
		logger.info(
			f'Analyzing extracted files for RTK data and image content',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		rtk_metadata, image_count, total_size_bytes = _analyze_extracted_files(extraction_dir, token, dataset_id)
		_update_raw_images_metadata(dataset_id, rtk_metadata, image_count, total_size_bytes, token)

		# Step 5: Extract EXIF metadata from images and update database
		logger.info(
			f'Extracting EXIF metadata from drone images',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		exif_metadata = _extract_exif_from_images(extraction_dir, token, dataset_id)
		if exif_metadata:
			_update_camera_metadata(dataset_id, exif_metadata, token)

		# Step 6: Execute ODM Docker container
		# For Docker-in-Docker, we need a path that's accessible from the host
		# Use /app/processor/temp (mounted from host) for ODM, then copy results to /data
		odm_host_temp_dir = Path('/app/processor') / 'temp' / f'odm_temp_{dataset_id}'
		odm_host_temp_dir.mkdir(parents=True, exist_ok=True)

		# Regular temp directory for non-ODM operations (stays in /data)
		regular_temp_dir = temp_dir / f'odm_temp_{dataset_id}'
		regular_temp_dir.mkdir(exist_ok=True)

		logger.info(
			f'Starting ODM processing with Docker container',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		_run_odm_container(images_dir=extraction_dir, output_dir=odm_host_temp_dir, token=token, dataset_id=dataset_id)

		# Step 7: Move generated orthomosaic to standard location
		project_name = f'dataset_{dataset_id}'
		orthomosaic_path = _find_orthomosaic(odm_host_temp_dir, project_name)
		if not orthomosaic_path:
			raise Exception('ODM did not generate an orthomosaic')

		# Push orthomosaic to storage server at standard location
		remote_ortho_path = f'{settings.archive_path}/{dataset_id}_ortho.tif'

		logger.info(
			f'Pushing generated orthomosaic to storage: {remote_ortho_path}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		push_file_to_storage_server(
			local_file_path=str(orthomosaic_path),
			remote_file_path=remote_ortho_path,
			token=token,
			dataset_id=dataset_id,
		)

		# Step 8: Update status
		update_status(dataset_id=dataset_id, is_odm_done=True, token=token)

		logger.info(
			f'ODM processing completed successfully for dataset {dataset_id}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		# Step 9: Cleanup temporary ODM directory
		if odm_host_temp_dir.exists():
			import shutil

			shutil.rmtree(odm_host_temp_dir)
			logger.info(
				f'Cleaned up temporary ODM directory: {odm_host_temp_dir}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)

	except Exception as e:
		logger.error(
			f'ODM processing failed for dataset {dataset_id}: {str(e)}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)
		# Ensure status reflects the error so the queue can skip this dataset until manual intervention
		try:
			update_status(token=token, dataset_id=dataset_id, has_error=True, error_message=str(e))
		except Exception:
			pass

		# Cleanup temporary ODM directory even on failure
		if 'odm_host_temp_dir' in locals() and odm_host_temp_dir.exists():
			import shutil

			shutil.rmtree(odm_host_temp_dir)
			logger.info(
				f'Cleaned up temporary ODM directory after failure: {odm_host_temp_dir}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)

		raise


def _analyze_extracted_files(extraction_dir: Path, token: str, dataset_id: int) -> tuple[dict, int, int]:
	"""
	Analyze extracted files to detect RTK data, count images, and calculate total size.

	Args:
		extraction_dir: Directory containing extracted images and RTK files
		token: Authentication token for logging
		dataset_id: Dataset ID for logging

	Returns:
		Tuple containing:
			rtk_metadata: Dictionary with RTK detection results
			image_count: Number of valid image files
			total_size_bytes: Total size of valid image files in bytes
	"""
	# Get list of all files in extraction directory
	extracted_files = []
	for file_path in extraction_dir.rglob('*'):
		if file_path.is_file():
			relative_path = file_path.relative_to(extraction_dir)
			extracted_files.append(str(relative_path))

	# Detect RTK files
	rtk_files = []
	rtk_file_types = {}
	for file_path in extracted_files:
		file_path_obj = Path(file_path)
		extension = file_path_obj.suffix.upper()

		if extension in RTK_EXTENSIONS:
			rtk_files.append(file_path)
			if extension not in rtk_file_types:
				rtk_file_types[extension] = []
			rtk_file_types[extension].append(file_path)

	# Count image files and calculate total size
	image_extensions = {'.jpg', '.jpeg', '.png', '.tif', '.tiff', '.dng', '.raw'}
	image_count = 0
	total_size_bytes = 0

	for file_path in extracted_files:
		if Path(file_path).suffix.lower() in image_extensions:
			full_path = extraction_dir / file_path
			if full_path.exists():
				image_count += 1
				total_size_bytes += full_path.stat().st_size

	# Parse RTK timestamp data if available
	rtk_precision_cm = None
	rtk_quality_indicator = None
	if rtk_files:
		mrk_files = [f for f in extracted_files if f.upper().endswith('.MRK')]
		if mrk_files:
			mrk_path = extraction_dir / mrk_files[0]
			rtk_timestamp_data = _parse_rtk_timestamp_file(mrk_path, token, dataset_id)
			if rtk_timestamp_data.get('rtk_timestamp_available'):
				rtk_precision_cm = 2.0  # Typical RTK precision in cm
				rtk_quality_indicator = 5  # Quality indicator

	rtk_metadata = {
		'has_rtk_data': len(rtk_files) > 0,
		'rtk_file_count': len(rtk_files),
		'rtk_precision_cm': rtk_precision_cm,
		'rtk_quality_indicator': rtk_quality_indicator,
		'rtk_files': rtk_files,
		'rtk_file_types': rtk_file_types,
		'detected_extensions': list(rtk_file_types.keys()),
	}

	logger.info(
		f'Analysis complete: {len(rtk_files)} RTK files, {image_count} images, {total_size_bytes} bytes total',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	return rtk_metadata, image_count, total_size_bytes


def _parse_rtk_timestamp_file(mrk_path: Path, token: str, dataset_id: int) -> Dict[str, Any]:
	"""Parse RTK timestamp file for basic metadata"""
	if not mrk_path.exists():
		return {'rtk_timestamp_available': False}

	try:
		# Read first few lines to extract basic info
		with open(mrk_path, 'r', encoding='utf-8', errors='ignore') as f:
			lines = []
			for i, line in enumerate(f):
				if i >= 10:  # Only read first 10 lines for basic info
					break
				lines.append(line.strip())

		logger.info(
			f'Successfully parsed RTK timestamp file {mrk_path.name} with {len(lines)} lines',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		return {
			'rtk_timestamp_available': True,
			'mrk_file_path': str(mrk_path),
			'file_size_bytes': mrk_path.stat().st_size,
			'line_count_sample': len(lines),
			'records_count': len(lines),
			'has_content': len(lines) > 0,
			'first_line_preview': lines[0] if lines else None,
		}

	except Exception as e:
		logger.warning(
			f'Failed to parse RTK timestamp file {mrk_path.name}: {str(e)}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)
		return {
			'rtk_timestamp_available': False,
			'parse_error': str(e),
			'mrk_file_path': str(mrk_path),
			'records_count': 0,
		}


def _update_raw_images_metadata(
	dataset_id: int, rtk_metadata: dict, image_count: int, total_size_bytes: int, token: str
):
	"""
	Update the raw_images table with RTK metadata, image count, and total size.

	Args:
		dataset_id: Dataset ID to update
		rtk_metadata: Dictionary containing RTK detection results
		image_count: Number of valid image files
		total_size_bytes: Total size of valid image files in bytes
		token: Authentication token for database access
	"""
	# Convert bytes to MB for storage
	total_size_mb = max(1, total_size_bytes // (1024 * 1024))

	with use_client(token) as client:
		response = (
			client.table(settings.raw_images_table)
			.update(
				{
					'raw_image_count': image_count,
					'raw_image_size_mb': total_size_mb,
					'has_rtk_data': rtk_metadata.get('has_rtk_data', False),
					'rtk_precision_cm': rtk_metadata.get('rtk_precision_cm'),
					'rtk_quality_indicator': rtk_metadata.get('rtk_quality_indicator'),
					'rtk_file_count': rtk_metadata.get('rtk_file_count', 0),
				}
			)
			.eq('dataset_id', dataset_id)
			.execute()
		)

		if response.data:
			logger.info(
				f'Successfully updated raw_images metadata for dataset {dataset_id}: {image_count} images, {rtk_metadata.get("rtk_file_count", 0)} RTK files, {total_size_mb}MB total',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
		else:
			logger.error(
				f'Failed to update raw_images metadata for dataset {dataset_id} - no raw_images entry found',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)


def _extract_exif_from_images(extraction_dir: Path, token: str, dataset_id: int) -> dict:
	"""
	Extract EXIF metadata from the first valid image file with EXIF data.

	Args:
		extraction_dir: Directory containing extracted images
		token: Authentication token for logging
		dataset_id: Dataset ID for logging

	Returns:
		Dictionary containing comprehensive EXIF metadata, or empty dict if none found
	"""
	# Find image files in extraction directory (search recursively)
	image_extensions = ['.jpg', '.jpeg', '.tif', '.tiff', '.JPG', '.JPEG', '.TIF', '.TIFF']
	image_files = []

	for ext in image_extensions:
		found_files = list(extraction_dir.rglob(f'*{ext}'))
		# Filter out files in __MACOSX directories
		filtered_files = [f for f in found_files if '__MACOSX' not in str(f)]
		image_files.extend(filtered_files)

	if not image_files:
		logger.warning(
			f'No image files found in extraction directory: {extraction_dir}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)
		return {}

	logger.info(
		f'Found {len(image_files)} image files, extracting EXIF from first valid image',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	# Sample first 3 images to find representative EXIF data
	for image_file in image_files[:3]:
		try:
			exif_data = extract_comprehensive_exif(image_file)
			if exif_data:
				logger.info(
					f'Successfully extracted EXIF metadata from {image_file.name} with {len(exif_data)} fields',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)
				return exif_data
		except Exception as e:
			logger.warning(
				f'Failed to extract EXIF from {image_file.name}: {str(e)}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
			continue

	logger.warning(
		'No valid EXIF data found in any of the sampled image files',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)
	return {}


def _update_camera_metadata(dataset_id: int, exif_metadata: dict, token: str):
	"""
	Update the camera_metadata field in v2_raw_images table with EXIF data.

	Args:
		dataset_id: Dataset ID to update
		exif_metadata: Dictionary containing EXIF metadata
		token: Authentication token for database access
	"""
	with use_client(token) as client:
		response = (
			client.table(settings.raw_images_table)
			.update({'camera_metadata': exif_metadata})
			.eq('dataset_id', dataset_id)
			.execute()
		)

		if response.data:
			logger.info(
				f'Successfully updated camera_metadata for dataset {dataset_id} with {len(exif_metadata)} EXIF fields',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
		else:
			logger.error(
				f'Failed to update camera_metadata for dataset {dataset_id} - no raw_images entry found',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)


def _run_odm_container(images_dir: Path, output_dir: Path, token: str, dataset_id: int):
	"""
	Execute ODM Docker container using shared named volumes for file sharing.
	This approach eliminates host path complexity and works identically in test and production.

	Args:
	    images_dir: Directory containing extracted drone images
	    output_dir: Directory for ODM output results
	    token: Authentication token for logging
	    dataset_id: Dataset ID for logging
	"""
	client = docker.from_env()
	volume_name = f'odm_processing_{dataset_id}'

	logger.info(
		f'Starting ODM processing with shared volume approach for dataset {dataset_id}',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	# Find all files recursively, excluding __MACOSX directories
	all_files = []
	for file_path in images_dir.rglob('*'):
		if file_path.is_file() and '__MACOSX' not in str(file_path):
			all_files.append(file_path)

	# Separate files by type
	image_files = []
	rtk_files = []
	other_files = []

	# Common image extensions (be inclusive, let ODM validate)
	image_extensions = {'.jpg', '.jpeg', '.png', '.tif', '.tiff', '.dng', '.raw', '.bmp', '.webp'}

	for file_path in all_files:
		ext = file_path.suffix.lower()
		if ext in image_extensions:
			image_files.append(file_path)
		elif ext.upper() in RTK_EXTENSIONS:
			rtk_files.append(file_path)
		else:
			other_files.append(file_path)

	logger.info(
		f'Found {len(image_files)} image files, {len(rtk_files)} RTK files, {len(other_files)} other files in {images_dir}',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	if len(image_files) == 0:
		# Log directory structure for debugging
		logger.error(
			f'No image files found. Directory contains: {[f.name for f in all_files[:20]]}{"..." if len(all_files) > 20 else ""}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)
		raise Exception(f'No supported images found in {images_dir}')

	# Filter out obviously corrupt images by size (but be less restrictive - 100KB minimum)
	valid_image_files = []
	for image_file in image_files:
		file_size = image_file.stat().st_size
		if file_size > 100 * 1024:  # At least 100KB (less restrictive than 1MB)
			valid_image_files.append(image_file)
		else:
			logger.warning(
				f'Skipping potentially corrupt image {image_file.name} (size: {file_size} bytes)',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)

	logger.info(
		f'Preparing to copy {len(valid_image_files)} valid images to shared volume (filtered out {len(image_files) - len(valid_image_files)} potentially corrupt images)',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	try:
		# Create shared volume for this processing session
		volume = client.volumes.create(name=volume_name)

		logger.info(
			f'Created shared volume {volume_name} for ODM processing',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		# Copy files to shared volume using the current approach
		copy_files_to_shared_volume(images_dir, valid_image_files, rtk_files, volume_name, dataset_id, token)

		# Environment-aware ODM configuration
		project_name = f'dataset_{dataset_id}'
		odm_command = []  # Always use fast processing

		# Set resolution based on environment
		if settings.DEV_MODE:
			# Development/Test: Fast processing with lower resolution
			resolution = '50.0'  # 50cm/pixel for fast testing
			odm_command.extend(
				[
					'--fast-orthophoto',
					'--skip-3dmodel',  # Skip 3D model generation (faster for 2D outputs)
					'--max-concurrency',
					'2',  # Limit parallel processes for testing
					'--crop',
					'0.1',  # Crop with 0.1m buffer for cleaner boundaries
				]
			)
		else:
			# Production: High quality processing
			resolution = '1.0'  # 1cm/pixel for production quality
			odm_command.extend(
				[
					'--fast-orthophoto',
					'--feature-quality',
					'ultra',
					'--matcher-neighbors',
					'12',
					'--crop',
					'0.1',  # Crop with 0.1m buffer for cleaner boundaries
				]
			)

		# Add common parameters
		odm_command.extend(
			[
				'--orthophoto-resolution',
				resolution,  # Environment-specific resolution (1cm production, 50cm test)
				'--project-path',
				'/odm_data',
				project_name,  # This is the PROJECTDIR argument
			]
		)

		# Log with environment-specific details
		env_mode = 'Speed optimized' if settings.DEV_MODE else 'Production quality'
		logger.info(
			f'Starting ODM processing with command: {" ".join(odm_command)} (Resolution: {resolution}cm/pixel, {env_mode})',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		# Create ODM container with shared volume (environment-agnostic approach)
		container = None
		container_created = False

		try:
			logger.info(
				f'Creating ODM container with shared volume {volume_name}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)

			container = client.containers.create(
				image='opendronemap/odm',
				command=odm_command,
				volumes={volume_name: {'bind': '/odm_data', 'mode': 'rw'}},
				# user='1000:1000',  # Removed - running as root for simplicity
				auto_remove=False,  # We'll manage removal manually to ensure cleanup
			)
			container_created = True

			# Start the container
			container.start()

			logger.info(
				'ODM container started, processing images...',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)

			# Wait for completion and get logs
			exit_status = container.wait()['StatusCode']

			# Get both stdout and stderr logs
			stdout_logs = container.logs(stdout=True, stderr=False).decode('utf-8', errors='ignore')
			stderr_logs = container.logs(stdout=False, stderr=True).decode('utf-8', errors='ignore')

			if exit_status == 0:
				logger.info(
					'ODM processing completed successfully',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)

				# Log output for debugging
				if stdout_logs:
					# Log last 1000 chars to avoid huge logs but still show completion status
					stdout_tail = stdout_logs[-1000:] if len(stdout_logs) > 1000 else stdout_logs
					logger.info(
						f'ODM stdout (tail): {stdout_tail}',
						LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
					)

				# Copy results from shared volume to output directory
				copy_results_from_shared_volume(volume_name, output_dir, project_name, dataset_id, token)
			else:
				# ODM failed - log detailed error information
				logger.error(
					f'ODM container failed with exit code {exit_status}',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)

				if stderr_logs:
					logger.error(
						f'ODM stderr: {stderr_logs}',
						LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
					)

				if stdout_logs:
					# Log the last part of stdout which often contains error info
					stdout_tail = stdout_logs[-2000:] if len(stdout_logs) > 2000 else stdout_logs
					logger.error(
						f'ODM stdout (tail): {stdout_tail}',
						LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
					)

				# Check if images directory exists and has content for debugging
				if images_dir.exists():
					image_files = list(images_dir.glob('*.jpg')) + list(images_dir.glob('*.JPG'))
					logger.error(
						f'Images directory contains {len(image_files)} image files: {[f.name for f in image_files[:5]]}',
						LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
					)
				else:
					logger.error(
						f'Images directory {images_dir} does not exist!',
						LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
					)

				raise Exception(
					f'ODM processing failed with exit code {exit_status}. stdout: {stdout_logs[-500:] if stdout_logs else "No stdout"}. stderr: {stderr_logs[-500:] if stderr_logs else "No stderr"}'
				)
		finally:
			# Always remove the container, even if an exception occurred
			if container_created and container:
				try:
					container.remove()
					logger.info(
						'ODM container removed successfully',
						LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
					)
				except Exception as cleanup_error:
					logger.error(
						f'Failed to remove ODM container: {str(cleanup_error)}',
						LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
					)

	except Exception as e:
		logger.error(
			f'Failed to run ODM container: {str(e)}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)
		# Mark dataset status with error to prevent immediate re-tries
		try:
			update_status(token=token, dataset_id=dataset_id, has_error=True, error_message=str(e))
		except Exception:
			pass
		raise
	finally:
		# Always clean up the shared volume
		try:
			volume.remove()
			logger.info(
				f'Shared volume {volume_name} removed successfully',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
		except Exception as volume_cleanup_error:
			logger.error(
				f'Failed to remove shared volume {volume_name}: {str(volume_cleanup_error)}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)


def _find_orthomosaic(output_dir: Path, project_name: str) -> Optional[Path]:
	"""
	Find the generated orthomosaic file in ODM output directory.

	Args:
	    output_dir: ODM output directory containing project directory
	    project_name: Name of the ODM project directory

	Returns:
	    Path to orthomosaic file or None if not found
	"""
	# ODM outputs orthomosaic in PROJECT/odm_orthophoto/odm_orthophoto.tif
	project_dir = output_dir / project_name

	# Debug: Log what's actually in the output directory
	logger.info(f'Looking for orthomosaic in: {project_dir}')
	if project_dir.exists():
		all_files = list(project_dir.rglob('*'))
		logger.info(f'Files in project directory: {[str(f.relative_to(project_dir)) for f in all_files[:20]]}')

		# Look specifically in odm_orthophoto directory
		orthophoto_dir = project_dir / 'odm_orthophoto'
		if orthophoto_dir.exists():
			orthophoto_files = list(orthophoto_dir.iterdir())
			logger.info(f'Files in odm_orthophoto directory: {[f.name for f in orthophoto_files]}')
		else:
			logger.warning(f'odm_orthophoto directory does not exist in {project_dir}')
	else:
		logger.error(f'Project directory does not exist: {project_dir}')
		return None

	orthophoto_patterns = [
		project_dir / 'odm_orthophoto' / 'odm_orthophoto.tif',
		project_dir / 'odm_orthophoto' / 'odm_orthophoto.original.tif',  # ODM often generates .original.tif
		project_dir / 'odm_orthophoto' / 'odm_orthophoto.png',
		# Fallback: look for any .tif file in project directory
	]

	for pattern in orthophoto_patterns:
		logger.debug(f'Checking pattern: {pattern}')
		if pattern.exists():
			logger.info(f'Found orthomosaic at: {pattern}')
			return pattern

	# Fallback: search for any .tif files in the project directory
	for tif_file in project_dir.rglob('*.tif'):
		if 'orthophoto' in tif_file.name.lower():
			logger.info(f'Found orthomosaic via fallback search: {tif_file}')
			return tif_file

	logger.error(f'No orthomosaic found in {project_dir}')
	return None
