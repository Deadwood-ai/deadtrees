import os
import zipfile
import shutil
import docker
from pathlib import Path
from typing import Optional

from shared.models import QueueTask
from shared.logger import logger
from shared.settings import settings
from shared.status import update_status
from shared.logging import LogContext, LogCategory
from processor.src.utils.ssh import pull_file_from_storage_server, push_file_to_storage_server


def process_odm(task: QueueTask, temp_dir: Path):
	"""
	Process ODM (OpenDroneMap) task for raw drone images.

	Steps:
	1. Pull original ZIP file from storage via SSH
	2. Extract ZIP file locally
	3. Execute ODM Docker container with GPU acceleration
	4. Move generated orthomosaic to archive/{dataset_id}_ortho.tif
	5. Update status is_odm_done=True

	Args:
		task: QueueTask with dataset_id and user information
		temp_dir: Temporary directory for processing
	"""
	from shared.db import login

	dataset_id = task.dataset_id
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

	logger.info(
		f'Starting ODM processing for dataset {dataset_id}',
		LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
	)

	try:
		# Step 1: Pull original ZIP file from storage
		zip_filename = f'{dataset_id}.zip'
		remote_zip_path = f'{settings.raw_images_path}/{zip_filename}'
		local_zip_path = temp_dir / zip_filename

		logger.info(
			f'Pulling ZIP file from storage: {remote_zip_path}',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)

		pull_file_from_storage_server(
			remote_file_path=remote_zip_path, local_file_path=str(local_zip_path), token=token, dataset_id=dataset_id
		)

		# Step 2: Extract ZIP file locally
		extraction_dir = temp_dir / f'raw_images_{dataset_id}'
		extraction_dir.mkdir(exist_ok=True)

		logger.info(
			f'Extracting ZIP file to: {extraction_dir}',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)

		with zipfile.ZipFile(local_zip_path, 'r') as zip_ref:
			zip_ref.extractall(extraction_dir)

		# Step 3: Execute ODM Docker container
		# Use temp_dir (which is /data/processing_dir) for ODM output
		odm_output_dir = temp_dir / f'odm_temp_{dataset_id}'
		odm_output_dir.mkdir(exist_ok=True)

		logger.info(
			f'Starting ODM processing with Docker container',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)

		_run_odm_container(images_dir=extraction_dir, output_dir=odm_output_dir, token=token, dataset_id=dataset_id)

		# Step 4: Move generated orthomosaic to standard location
		project_name = f'dataset_{dataset_id}'
		orthomosaic_path = _find_orthomosaic(odm_output_dir, project_name)
		if not orthomosaic_path:
			raise Exception('ODM did not generate an orthomosaic')

		# Push orthomosaic to storage server at standard location
		remote_ortho_path = f'{settings.archive_path}/{dataset_id}_ortho.tif'

		logger.info(
			f'Pushing generated orthomosaic to storage: {remote_ortho_path}',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)

		push_file_to_storage_server(
			local_file_path=str(orthomosaic_path),
			remote_file_path=remote_ortho_path,
			token=token,
			dataset_id=dataset_id,
		)

		# Step 5: Update status
		update_status(dataset_id=dataset_id, is_odm_done=True, token=token)

		logger.info(
			f'ODM processing completed successfully for dataset {dataset_id}',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)

		# Step 6: Cleanup temporary ODM directory
		if odm_output_dir.exists():
			import shutil

			shutil.rmtree(odm_output_dir)
			logger.info(
				f'Cleaned up temporary ODM directory: {odm_output_dir}',
				LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
			)

	except Exception as e:
		logger.error(
			f'ODM processing failed for dataset {dataset_id}: {str(e)}',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)

		# Cleanup temporary ODM directory even on failure
		if 'odm_output_dir' in locals() and odm_output_dir.exists():
			import shutil

			shutil.rmtree(odm_output_dir)
			logger.info(
				f'Cleaned up temporary ODM directory after failure: {odm_output_dir}',
				LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
			)

		raise


def _run_odm_container(images_dir: Path, output_dir: Path, token: str, dataset_id: int):
	"""
	Execute ODM Docker container using Docker Python API with correct command structure.

	Args:
	    images_dir: Directory containing extracted drone images
	    output_dir: Directory for ODM output (this will contain the project directory)
	    token: Authentication token for logging
	    dataset_id: Dataset ID for logging
	"""
	client = docker.from_env()

	# Create project directory structure that ODM expects
	project_name = f'dataset_{dataset_id}'
	project_dir = output_dir / project_name
	project_images_dir = project_dir / 'images'

	# Create the project directory structure
	project_dir.mkdir(exist_ok=True)
	project_images_dir.mkdir(exist_ok=True)

	# Copy images to the expected ODM project structure
	image_files = list(images_dir.glob('*.jpg')) + list(images_dir.glob('*.JPG'))

	# Filter out obviously corrupt images by size (very small files are likely corrupt)
	valid_image_files = []
	for image_file in image_files:
		if image_file.stat().st_size > 1024 * 1024:  # At least 1MB
			valid_image_files.append(image_file)
		else:
			logger.warning(
				f'Skipping potentially corrupt image {image_file.name} (size: {image_file.stat().st_size} bytes)',
				LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
			)

	for image_file in valid_image_files:
		shutil.copy2(image_file, project_images_dir)

	logger.info(
		f'Copied {len(valid_image_files)} valid images to ODM project structure (filtered out {len(image_files) - len(valid_image_files)} potentially corrupt images)',
		LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
	)

	# Improved ODM Docker configuration optimized for small datasets
	odm_command = [
		'--fast-orthophoto',  # Fast processing mode
		'--orthophoto-resolution',
		'10',  # 10cm/pixel resolution (faster for small datasets)
		'--feature-quality',
		'low',  # Low quality features (more robust for small datasets)
		'--matcher-neighbors',
		'4',  # Use fewer neighbors for small datasets
		'--min-num-features',
		'4000',  # Lower minimum features for small datasets
		'--ignore-gsd',  # Ignore Ground Sample Distance warnings
		'--skip-3dmodel',  # Skip 3D model generation (we only need orthophoto)
		'--force-gps',  # Force GPS usage even with few images
		'--use-hybrid-bundle-adjustment',  # Better for small datasets
		'--project-path',
		'/odm_data',
		project_name,  # This is the PROJECTDIR argument
	]

	logger.info(
		f'Starting ODM processing with command: {" ".join(odm_command)}',
		LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
	)

	try:
		# Run ODM container using Docker Python API with detailed logging
		logger.info(
			f'Creating ODM container with volumes: {str(output_dir)}:/odm_data',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)

		# Debug: Check what we're mounting
		logger.info(
			f'Host directory structure: {output_dir} -> {list(output_dir.iterdir()) if output_dir.exists() else "does not exist"}',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)
		logger.info(
			f'Project directory: {project_dir} -> {list(project_dir.iterdir()) if project_dir.exists() else "does not exist"}',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)

		# Convert container path to host path for Docker-in-Docker
		# The processor container has /data mounted from host, so we need to use the host path
		container_path = str(output_dir)
		if container_path.startswith('/data/'):
			# For /data paths, mount directly since /data is mounted from host to processor
			host_path = container_path
		else:
			# Fallback to container path
			host_path = container_path

		logger.info(
			f'Mounting host path {host_path} as /odm_data in ODM container',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)

		# Mount the parent directory so ODM can find the project directory
		# Use host path since /data is mounted from host to processor container
		container = client.containers.create(
			image='opendronemap/odm',
			command=odm_command,
			volumes={host_path: {'bind': '/odm_data', 'mode': 'rw'}},
			auto_remove=False,  # Keep container for debugging
		)

		# Start the container
		container.start()

		# Debug: Check what ODM sees in the container (simplified - no decode issues)
		logger.info(
			'ODM container started, processing images...',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)

		# Wait for completion and get logs
		exit_status = container.wait()['StatusCode']

		# Get both stdout and stderr logs
		stdout_logs = container.logs(stdout=True, stderr=False).decode('utf-8', errors='ignore')
		stderr_logs = container.logs(stdout=False, stderr=True).decode('utf-8', errors='ignore')

		# Remove the container now that we have the logs
		container.remove()

		if exit_status == 0:
			logger.info(
				'ODM processing completed successfully',
				LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
			)

			# Log output for debugging
			if stdout_logs:
				# Log last 1000 chars to avoid huge logs but still show completion status
				stdout_tail = stdout_logs[-1000:] if len(stdout_logs) > 1000 else stdout_logs
				logger.info(
					f'ODM stdout (tail): {stdout_tail}',
					LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
				)
		else:
			# ODM failed - log detailed error information
			logger.error(
				f'ODM container failed with exit code {exit_status}',
				LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
			)

			if stderr_logs:
				logger.error(
					f'ODM stderr: {stderr_logs}',
					LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
				)

			if stdout_logs:
				# Log the last part of stdout which often contains error info
				stdout_tail = stdout_logs[-2000:] if len(stdout_logs) > 2000 else stdout_logs
				logger.error(
					f'ODM stdout (tail): {stdout_tail}',
					LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
				)

			# Check if images directory exists and has content for debugging
			if images_dir.exists():
				image_files = list(images_dir.glob('*.jpg')) + list(images_dir.glob('*.JPG'))
				logger.error(
					f'Images directory contains {len(image_files)} image files: {[f.name for f in image_files[:5]]}',
					LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
				)
			else:
				logger.error(
					f'Images directory {images_dir} does not exist!',
					LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
				)

			raise Exception(
				f'ODM processing failed with exit code {exit_status}. stdout: {stdout_logs[-500:] if stdout_logs else "No stdout"}. stderr: {stderr_logs[-500:] if stderr_logs else "No stderr"}'
			)
	except Exception as e:
		logger.error(
			f'Failed to run ODM container: {str(e)}',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)
		raise


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
	orthophoto_patterns = [
		project_dir / 'odm_orthophoto' / 'odm_orthophoto.tif',
		project_dir / 'odm_orthophoto' / 'odm_orthophoto.png',
		# Fallback: look for any .tif file in project directory
	]

	for pattern in orthophoto_patterns:
		if pattern.exists():
			return pattern

	# Fallback: search for any .tif files in the project directory
	for tif_file in project_dir.rglob('*.tif'):
		if 'orthophoto' in tif_file.name.lower():
			return tif_file

	return None
