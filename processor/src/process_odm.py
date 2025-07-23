import os
import zipfile
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
		odm_output_dir = temp_dir / f'odm_output_{dataset_id}'
		odm_output_dir.mkdir(exist_ok=True)

		logger.info(
			f'Starting ODM processing with Docker container',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)

		_run_odm_container(images_dir=extraction_dir, output_dir=odm_output_dir, token=token, dataset_id=dataset_id)

		# Step 4: Move generated orthomosaic to standard location
		orthomosaic_path = _find_orthomosaic(odm_output_dir)
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

	except Exception as e:
		logger.error(
			f'ODM processing failed for dataset {dataset_id}: {str(e)}',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)
		raise


def _run_odm_container(images_dir: Path, output_dir: Path, token: str, dataset_id: int):
	"""
	Execute ODM Docker container with GPU acceleration.

	Args:
	    images_dir: Directory containing extracted drone images
	    output_dir: Directory for ODM output
	    token: Authentication token for logging
	    dataset_id: Dataset ID for logging
	"""
	client = docker.from_env()

	# ODM Docker configuration
	container_config = {
		'image': 'opendronemap/odm',
		'volumes': {
			str(images_dir): {'bind': '/code/images', 'mode': 'ro'},
			str(output_dir): {'bind': '/code/odm_output', 'mode': 'rw'},
		},
		'working_dir': '/code',
		'command': [
			'--project-path',
			'/code',
			'--orthophoto-resolution',
			'2',
			'--feature-quality',
			'medium',
			'--pc-quality',
			'medium',
		],
		'remove': True,
		'stdout': True,
		'stderr': True,
	}

	# Add GPU support if available
	if _gpu_available():
		container_config['device_requests'] = [docker.types.DeviceRequest(count=-1, capabilities=[['gpu']])]
		logger.info(
			'GPU acceleration enabled for ODM processing',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)

	logger.info(
		f'Running ODM container with images from {images_dir}',
		LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
	)

	try:
		# Run ODM container
		container = client.containers.run(**container_config)

		logger.info(
			'ODM container completed successfully',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)

	except docker.errors.ContainerError as e:
		logger.error(
			f'ODM container failed with exit code {e.exit_status}: {e.stderr.decode()}',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)
		raise Exception(f'ODM processing failed: {e.stderr.decode()}')

	except Exception as e:
		logger.error(
			f'Failed to run ODM container: {str(e)}',
			LogContext(category=LogCategory.PROCESS, token=token, dataset_id=dataset_id),
		)
		raise


def _find_orthomosaic(output_dir: Path) -> Optional[Path]:
	"""
	Find the generated orthomosaic file in ODM output directory.

	Args:
	    output_dir: ODM output directory

	Returns:
	    Path to orthomosaic file or None if not found
	"""
	# ODM typically outputs orthomosaic in odm_orthophoto/odm_orthophoto.tif
	orthophoto_patterns = [
		output_dir / 'odm_orthophoto' / 'odm_orthophoto.tif',
		output_dir / 'odm_output' / 'odm_orthophoto' / 'odm_orthophoto.tif',
		# Fallback: look for any .tif file in output
	]

	for pattern in orthophoto_patterns:
		if pattern.exists():
			return pattern

	# Fallback: search for any .tif files
	for tif_file in output_dir.rglob('*.tif'):
		if 'orthophoto' in tif_file.name.lower():
			return tif_file

	return None


def _gpu_available() -> bool:
	"""
	Check if GPU is available for Docker containers.

	Returns:
	    True if GPU is available, False otherwise
	"""
	try:
		client = docker.from_env()
		# Try to run a simple GPU test container
		result = client.containers.run(
			'nvidia/cuda:11.8-runtime-ubuntu20.04',
			'nvidia-smi',
			remove=True,
			device_requests=[docker.types.DeviceRequest(count=-1, capabilities=[['gpu']])],
		)
		return True
	except:
		return False
