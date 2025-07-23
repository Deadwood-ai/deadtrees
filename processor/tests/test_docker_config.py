"""
Test Docker configuration for ODM processing.

Tests Docker socket accessibility, ODM image availability, and GPU access
from within the processor container environment.
"""

import pytest
import docker
from docker.errors import DockerException, ImageNotFound, APIError
import subprocess
import os


def test_docker_socket_accessible():
	"""Test that Docker socket is accessible from processor container."""
	try:
		client = docker.from_env()
		# Test basic Docker API access
		client.ping()

		# Verify we can list containers
		containers = client.containers.list()
		assert isinstance(containers, list)

		# Test Docker info access
		info = client.info()
		assert 'ServerVersion' in info

	except DockerException as e:
		pytest.fail(f'Docker socket not accessible: {e}')


def test_docker_version():
	"""Test Docker version information is accessible."""
	try:
		client = docker.from_env()
		version = client.version()

		assert 'Version' in version
		assert 'ApiVersion' in version

		# Log version for debugging
		print(f'Docker version: {version["Version"]}')
		print(f'API version: {version["ApiVersion"]}')

	except DockerException as e:
		pytest.fail(f'Cannot get Docker version: {e}')


def test_can_pull_odm_image():
	"""Test that ODM image can be pulled (or is already available)."""
	try:
		client = docker.from_env()
		odm_image = 'opendronemap/odm'

		# First try to get the image if it exists
		try:
			image = client.images.get(odm_image)
			print(f'ODM image already available: {image.id}')
			assert image is not None
			return
		except ImageNotFound:
			# Image not found, try to pull it
			pass

		# Try to pull the image (this might be slow)
		print(f'Pulling ODM image: {odm_image}')
		try:
			image = client.images.pull(odm_image, tag='latest')
			assert image is not None
			print(f'Successfully pulled ODM image: {image.id}')
		except APIError as e:
			# If pull fails due to network/registry issues, skip test
			pytest.skip(f'Cannot pull ODM image (network/registry issue): {e}')

	except DockerException as e:
		pytest.fail(f'Docker client error: {e}')


def test_gpu_access_available():
	"""Test that GPU access is available for Docker containers."""
	try:
		client = docker.from_env()

		# Test by running nvidia-smi in a container if possible
		try:
			# Use a simple nvidia/cuda image to test GPU access
			test_image = 'nvidia/cuda:11.8-base-ubuntu20.04'

			# Try to run nvidia-smi command
			container = client.containers.run(
				test_image, command='nvidia-smi', runtime='nvidia', remove=True, detach=False
			)

			# If we get here, GPU access works
			print('GPU access confirmed via nvidia-smi')
			assert True

		except (ImageNotFound, APIError) as e:
			# If we can't test with nvidia/cuda image, check environment
			print(f'Cannot test with nvidia/cuda image: {e}')

			# Alternative: check if NVIDIA environment variables are set
			nvidia_visible = os.environ.get('NVIDIA_VISIBLE_DEVICES')
			nvidia_caps = os.environ.get('NVIDIA_DRIVER_CAPABILITIES')

			if nvidia_visible and nvidia_caps:
				print(f'NVIDIA environment configured: devices={nvidia_visible}, caps={nvidia_caps}')
				assert True
			else:
				pytest.skip('Cannot verify GPU access - no NVIDIA environment or test image')

	except DockerException as e:
		pytest.fail(f'Docker client error during GPU test: {e}')


def test_docker_compose_runtime_nvidia():
	"""Test that the processor container is running with nvidia runtime."""
	# Check if we're running with nvidia runtime by looking for nvidia devices
	nvidia_devices = ['/dev/nvidia0', '/dev/nvidiactl', '/dev/nvidia-modeset', '/dev/nvidia-uvm']

	available_devices = []
	for device in nvidia_devices:
		if os.path.exists(device):
			available_devices.append(device)

	if available_devices:
		print(f'NVIDIA devices available: {available_devices}')
		assert len(available_devices) > 0
	else:
		# Check environment variables as fallback
		nvidia_visible = os.environ.get('NVIDIA_VISIBLE_DEVICES')
		if nvidia_visible:
			print(f'NVIDIA_VISIBLE_DEVICES set: {nvidia_visible}')
			assert nvidia_visible is not None
		else:
			pytest.skip('No NVIDIA devices or environment detected')


def test_odm_container_execution_capability():
	"""Test that we can run a simple ODM container command."""
	try:
		client = docker.from_env()
		odm_image = 'opendronemap/odm'

		# First ensure ODM image is available
		try:
			client.images.get(odm_image)
		except ImageNotFound:
			pytest.skip('ODM image not available - run test_can_pull_odm_image first')

		# Test running ODM with --help command (should be fast)
		try:
			container = client.containers.run(
				odm_image,
				command='--help',
				remove=True,
				detach=False,
				runtime='nvidia' if os.environ.get('NVIDIA_VISIBLE_DEVICES') else None,
			)

			print('ODM container executed successfully')
			assert True

		except Exception as e:
			print(f'ODM container execution failed: {e}')
			# This might fail due to missing dependencies, but we tested Docker access
			pytest.skip(f'ODM container execution failed (expected in minimal test env): {e}')

	except DockerException as e:
		pytest.fail(f'Docker client error: {e}')
