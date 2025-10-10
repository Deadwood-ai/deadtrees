"""
Shared volume utilities for Docker container file sharing.

This module provides functions for copying files to and from Docker named volumes
using temporary Alpine containers. This approach eliminates host path dependencies
and works identically in test and production environments.
"""

import docker
import tarfile
import io
import time
from pathlib import Path
from shared.logger import logger
from shared.logging import LogContext, LogCategory


class _GeneratorStream(io.RawIOBase):
	"""
	Wraps a generator to provide a file-like interface for tarfile.

	Docker's get_archive() returns a generator, but tarfile.open() expects
	a file-like object with a .read() method. This wrapper bridges that gap
	by implementing the io.RawIOBase interface and streaming chunks from
	the generator without loading the entire archive into memory.
	"""

	def __init__(self, generator):
		self.generator = generator
		self.leftover = b''

	def readable(self):
		return True

	def readinto(self, b):
		try:
			length = len(b)
			chunk = self.leftover or next(self.generator)
			output, self.leftover = chunk[:length], chunk[length:]
			b[: len(output)] = output
			return len(output)
		except StopIteration:
			return 0  # Indicate EOF


def copy_files_to_shared_volume(
	images_dir: Path, valid_image_files: list, rtk_files: list, volume_name: str, dataset_id: int, token: str
):
	"""
	Copy input files to the shared volume using Docker API and temporary container.
	This creates the ODM project structure that ODM expects without requiring bind mounts.

	Args:
		images_dir: Directory containing the source files (unused in new implementation)
		valid_image_files: List of validated image files to copy
		rtk_files: List of RTK files to copy
		volume_name: Name of the Docker volume to copy files to
		dataset_id: Dataset ID for logging and project naming
		token: Authentication token for logging
	"""
	client = docker.from_env()
	project_name = f'dataset_{dataset_id}'

	logger.info(
		f'Copying {len(valid_image_files)} images and {len(rtk_files)} RTK files to shared volume using Docker API',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	# Create temporary container with named volume mounted
	temp_container = None
	try:
		container_name = f'dt-odm-transfer-d{dataset_id}-{int(time.time())}'
		temp_container = client.containers.create(
			image='alpine',
			volumes={volume_name: {'bind': '/odm_shared', 'mode': 'rw'}},
			command=['tail', '-f', '/dev/null'],  # Keep alive for file operations (no timeout)
			name=container_name,
			user='root',
			auto_remove=True,
			labels={
				'dt': 'odm',
				'dt_role': 'temp_transfer',
				'dt_dataset_id': str(dataset_id),
				'dt_volume': volume_name,
			},
		)
		temp_container.start()

		logger.info(
			f'Created temporary container {temp_container.short_id} for file transfer',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		# Create ODM project structure
		exec_result = temp_container.exec_run(f'mkdir -p /odm_shared/{project_name}/images')
		if exec_result.exit_code != 0:
			raise Exception(f'Failed to create directory structure: {exec_result.output.decode()}')

		# Helper function to copy a single file using Docker API
		def copy_file_to_container(file_path: Path, container_dest_path: str):
			"""Copy a file to container using put_archive API"""
			with open(file_path, 'rb') as f:
				file_data = f.read()

			# Create tar archive in memory
			tar_buffer = io.BytesIO()
			with tarfile.open(mode='w', fileobj=tar_buffer) as tar:
				tarinfo = tarfile.TarInfo(name=file_path.name)
				tarinfo.size = len(file_data)
				tar.addfile(tarinfo, io.BytesIO(file_data))

			tar_buffer.seek(0)
			temp_container.put_archive(container_dest_path, tar_buffer.getvalue())

		# Copy image files to images directory
		for img_file in valid_image_files:
			copy_file_to_container(img_file, f'/odm_shared/{project_name}/images/')
			logger.debug(
				f'Copied image file: {img_file.name}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)

		# Copy RTK files to project root
		for rtk_file in rtk_files:
			copy_file_to_container(rtk_file, f'/odm_shared/{project_name}/')
			logger.debug(
				f'Copied RTK file: {rtk_file.name}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)

		logger.info(
			f'Successfully copied files to shared volume {volume_name}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

	except Exception as e:
		logger.error(
			f'Failed to copy files to shared volume: {str(e)}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)
		raise
	finally:
		if temp_container:
			try:
				temp_container.remove(force=True)
				logger.debug(
					f'Cleaned up temporary container {temp_container.short_id}',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)
			except Exception as cleanup_error:
				logger.warning(
					f'Failed to cleanup temporary container: {cleanup_error}',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)


def copy_results_from_shared_volume(volume_name: str, output_dir: Path, project_name: str, dataset_id: int, token: str):
	"""
	Copy ODM results from the shared volume to the output directory using Docker API.

	Args:
		volume_name: Name of the Docker volume to copy results from
		output_dir: Local directory to copy results to
		project_name: ODM project name (usually dataset_{dataset_id})
		dataset_id: Dataset ID for logging
		token: Authentication token for logging
	"""
	client = docker.from_env()

	logger.info(
		f'Copying ODM results from shared volume {volume_name} to {output_dir} using Docker API',
		LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
	)

	# Ensure output directory exists
	output_dir.mkdir(parents=True, exist_ok=True)

	# Create temporary container with shared volume mounted
	temp_container = None
	try:
		container_name = f'dt-odm-extract-d{dataset_id}-{int(time.time())}'
		temp_container = client.containers.create(
			image='alpine',
			volumes={volume_name: {'bind': '/odm_shared', 'mode': 'ro'}},
			command=['tail', '-f', '/dev/null'],  # Keep alive for file operations (no timeout)
			name=container_name,
			user='root',
			auto_remove=True,
			labels={
				'dt': 'odm',
				'dt_role': 'temp_extract',
				'dt_dataset_id': str(dataset_id),
				'dt_volume': volume_name,
			},
		)
		temp_container.start()

		logger.info(
			f'Created temporary container {temp_container.short_id} for result extraction',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		# Check if project directory exists in volume
		exec_result = temp_container.exec_run(f'test -d /odm_shared/{project_name}')
		if exec_result.exit_code != 0:
			raise Exception(f'Project directory /odm_shared/{project_name} not found in volume')

		logger.info(
			'Project directory exists in volume, copying files',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

		# Get tar archive of entire project directory from container
		archive_stream, _ = temp_container.get_archive(f'/odm_shared/{project_name}')

		# Extract archive to output directory
		# FIXED: Wrap generator in file-like object for tarfile streaming
		# Docker's get_archive() returns a generator, but tarfile expects a file-like object
		# This prevents memory exhaustion on large datasets (40GB+) while properly handling the generator
		start_time = time.time()
		file_count = 0
		total_bytes = 0

		wrapped_stream = io.BufferedReader(_GeneratorStream(archive_stream))
		with tarfile.open(mode='r|*', fileobj=wrapped_stream) as tar:
			for member in tar:
				tar.extract(member, output_dir)
				file_count += 1
				total_bytes += member.size

				# Log progress every 100 files to track extraction
				if file_count % 100 == 0:
					elapsed = time.time() - start_time
					rate_mb_s = (total_bytes / 1024 / 1024) / elapsed if elapsed > 0 else 0
					logger.info(
						f'Extraction progress: {file_count} files, {total_bytes / 1024 / 1024:.1f} MB, {rate_mb_s:.1f} MB/s',
						LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
					)

		# Log final extraction stats
		total_time = time.time() - start_time
		avg_rate = (total_bytes / 1024 / 1024) / total_time if total_time > 0 else 0
		logger.info(
			f'Successfully copied ODM results from shared volume: {file_count} files, {total_bytes / 1024 / 1024:.1f} MB in {total_time:.1f}s ({avg_rate:.1f} MB/s)',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)

	except Exception as e:
		logger.error(
			f'Failed to copy results from shared volume: {str(e)}',
			LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
		)
		raise
	finally:
		if temp_container:
			try:
				temp_container.remove(force=True)
				logger.debug(
					f'Cleaned up temporary extraction container {temp_container.short_id}',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)
			except Exception as cleanup_error:
				logger.warning(
					f'Failed to cleanup temporary extraction container: {cleanup_error}',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)


def _containers_referencing_volume(client: docker.DockerClient, volume_name: str):
	"""Return a list of containers (running/created/exited) that reference a given volume."""
	try:
		return client.containers.list(all=True, filters={'volume': volume_name})
	except Exception:
		return []


def cleanup_volume_and_references(
	volume_name: str, token: str, dataset_id: int, attempts: int = 8, delay_seconds: float = 2.0
):
	"""
	Ensure a named Docker volume is cleaned up by:
	1) Removing any containers that reference it
	2) Removing the volume with retry/backoff
	"""
	client = docker.from_env()

	# Remove referencing containers first
	containers = _containers_referencing_volume(client, volume_name)
	for c in containers:
		try:
			try:
				c.reload()
				if getattr(c, 'status', '') == 'running':
					c.stop(timeout=10)
			except Exception:
				pass
			c.remove(force=True)
			logger.debug(
				f'Removed container {getattr(c, "short_id", "?")} referencing volume {volume_name}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
		except Exception as e:
			logger.warning(
				f'Failed removing container {getattr(c, "short_id", "?")} for volume {volume_name}: {e}',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)

	# Try to remove the volume with retries
	for attempt in range(1, attempts + 1):
		try:
			vol = client.volumes.get(volume_name)
			vol.remove()
			logger.info(
				f'Shared volume {volume_name} removed successfully',
				LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
			)
			return
		except Exception as e:
			if attempt >= attempts:
				logger.error(
					f'Failed to remove shared volume {volume_name} after {attempts} attempts: {e}',
					LogContext(category=LogCategory.ODM, token=token, dataset_id=dataset_id),
				)
				break
			# Re-enumerate references and backoff
			for c in _containers_referencing_volume(client, volume_name):
				try:
					c.remove(force=True)
				except Exception:
					pass
			time.sleep(delay_seconds)
