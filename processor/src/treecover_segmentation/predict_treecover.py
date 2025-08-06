import tempfile
import os
import uuid
from pathlib import Path
from typing import Optional
import numpy as np
import rasterio
import rasterio.warp
import docker
import tarfile
import io

from shared.logger import logger
from shared.models import LabelPayloadData, LabelSourceEnum, LabelTypeEnum, LabelDataEnum
from shared.labels import create_label_with_geometries, delete_model_prediction_labels
from shared.logging import LogContext, LogCategory
from ..deadwood_segmentation.deadtreesmodels.common.common import mask_to_polygons, reproject_polygons
from ..exceptions import ProcessingError

# TCD configuration (from original implementation)
TCD_THRESHOLD = 200
TCD_MODEL = 'restor/tcd-segformer-mit-b5'
TCD_TARGET_RESOLUTION = 0.1  # 10cm resolution
TCD_TARGET_CRS = 'EPSG:3395'  # Mercator projection for processing
TCD_OUTPUT_CRS = 'EPSG:4326'  # WGS84 for database storage
TCD_CONTAINER_IMAGE = 'deadtrees-tcd:latest'  # Our local TCD container


def _reproject_orthomosaic_for_tcd(input_tif: str, output_path: str) -> str:
	"""
	Reproject orthomosaic to EPSG:3395 with 10cm resolution for TCD container processing.

	This replaces the original convert_to_projected() function with rasterio.warp.reproject()
	to maintain the exact same output format without TCD Python dependencies.

	Args:
	    input_tif (str): Path to input orthomosaic
	    output_path (str): Path for reprojected output file

	Returns:
	    str: Path to reprojected file
	"""
	with rasterio.open(input_tif) as src:
		# Calculate transform for target CRS and resolution
		transform, width, height = rasterio.warp.calculate_default_transform(
			src.crs, TCD_TARGET_CRS, src.width, src.height, *src.bounds, resolution=TCD_TARGET_RESOLUTION
		)

		# Create output profile
		profile = src.profile.copy()
		profile.update({'crs': TCD_TARGET_CRS, 'transform': transform, 'width': width, 'height': height})

		# Reproject the image
		with rasterio.open(output_path, 'w', **profile) as dst:
			for i in range(1, src.count + 1):
				rasterio.warp.reproject(
					source=rasterio.band(src, i),
					destination=rasterio.band(dst, i),
					src_transform=src.transform,
					src_crs=src.crs,
					dst_transform=transform,
					dst_crs=TCD_TARGET_CRS,
					resampling=rasterio.warp.Resampling.bilinear,
				)

	return output_path


def _copy_ortho_to_tcd_volume(ortho_path: str, volume_name: str, dataset_id: int, token: str) -> str:
	"""
	Copy reprojected orthomosaic to TCD shared volume.

	Args:
	    ortho_path (str): Path to reprojected orthomosaic file
	    volume_name (str): Docker volume name
	    dataset_id (int): Dataset ID for directory structure
	    token (str): Authentication token for logging

	Returns:
	    str: Container path to the copied orthomosaic
	"""
	client = docker.from_env()
	project_name = f'dataset_{dataset_id}'
	container_ortho_path = f'/tcd_data/{project_name}/input/orthomosaic_reprojected.tif'

	logger.info(
		f'Copying reprojected orthomosaic to TCD shared volume',
		LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
	)

	# Create temporary container with named volume mounted
	temp_container = None
	try:
		temp_container = client.containers.create(
			image='alpine',
			volumes={volume_name: {'bind': '/tcd_data', 'mode': 'rw'}},
			command=['sleep', '60'],  # Keep alive for file operations
			user='root',
		)
		temp_container.start()

		# Create TCD directory structure (running as root for simplicity like ODM)
		exec_result = temp_container.exec_run(
			f'mkdir -p /tcd_data/{project_name}/input /tcd_data/{project_name}/output'
		)
		if exec_result.exit_code != 0:
			raise Exception(f'Failed to create TCD directory structure: {exec_result.output.decode()}')

		# Copy orthomosaic file using put_archive API
		with open(ortho_path, 'rb') as f:
			file_data = f.read()

		# Create tar archive in memory
		tar_buffer = io.BytesIO()
		with tarfile.open(mode='w', fileobj=tar_buffer) as tar:
			tarinfo = tarfile.TarInfo(name='orthomosaic_reprojected.tif')
			tarinfo.size = len(file_data)
			tar.addfile(tarinfo, io.BytesIO(file_data))

		tar_buffer.seek(0)
		temp_container.put_archive(f'/tcd_data/{project_name}/input/', tar_buffer.getvalue())

		logger.info(
			f'Successfully copied orthomosaic to TCD volume at {container_ortho_path}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		return container_ortho_path

	except Exception as e:
		logger.error(
			f'Failed to copy orthomosaic to TCD volume: {str(e)}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)
		raise
	finally:
		if temp_container:
			try:
				temp_container.remove(force=True)
			except Exception as cleanup_error:
				logger.warning(
					f'Failed to cleanup TCD copy container: {cleanup_error}',
					LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
				)


def _run_tcd_container(volume_name: str, dataset_id: int, token: str) -> str:
	"""
	Execute TCD container for semantic segmentation via shared volumes.

	Args:
	    volume_name (str): Docker volume name
	    dataset_id (int): Dataset ID
	    token (str): Authentication token for logging

	Returns:
	    str: Container path to output directory
	"""
	client = docker.from_env()
	project_name = f'dataset_{dataset_id}'
	input_path = f'/tcd_data/{project_name}/input/orthomosaic_reprojected.tif'
	output_path = f'/tcd_data/{project_name}/output'

	logger.info(
		f'Starting TCD container execution for dataset {dataset_id}',
		LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
	)

	try:
		# Pull TCD container image
		logger.info(
			'Pulling TCD container image if not available',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)
		# Use local container - no need to pull
		# client.images.pull('ghcr.io/restor-foundation/tcd:main')

		# Create and run TCD container
		container = client.containers.run(
			image=TCD_CONTAINER_IMAGE,
			command=['tcd-predict', 'semantic', input_path, output_path, f'--model={TCD_MODEL}'],
			volumes={volume_name: {'bind': '/tcd_data', 'mode': 'rw'}},
			remove=True,  # Auto-remove container when done
			detach=False,  # Wait for completion
			user='root',  # Run as root for simplicity like ODM
		)

		logger.info(
			f'TCD container execution completed successfully',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		return output_path

	except Exception as e:
		logger.error(
			f'TCD container execution failed: {str(e)}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)
		raise


def _copy_tcd_results_from_volume(volume_name: str, local_output_dir: Path, dataset_id: int, token: str) -> str:
	"""
	Copy TCD confidence map from shared volume to local directory.

	Args:
	    volume_name (str): Docker volume name
	    local_output_dir (Path): Local directory to copy results to
	    dataset_id (int): Dataset ID
	    token (str): Authentication token for logging

	Returns:
	    str: Path to extracted confidence_map.tif file
	"""
	client = docker.from_env()
	project_name = f'dataset_{dataset_id}'
	confidence_map_path = local_output_dir / 'confidence_map.tif'

	logger.info(
		f'Copying TCD results from shared volume to {local_output_dir}',
		LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
	)

	# Ensure output directory exists
	local_output_dir.mkdir(parents=True, exist_ok=True)

	# Create temporary container with shared volume mounted
	temp_container = None
	try:
		temp_container = client.containers.create(
			image='alpine',
			volumes={volume_name: {'bind': '/tcd_data', 'mode': 'ro'}},
			command=['sleep', '60'],  # Keep alive for file operations
			user='root',
		)
		temp_container.start()

		# List all files in the output directory to see what TCD actually generates
		exec_result = temp_container.exec_run(f'ls -la /tcd_data/{project_name}/output/')
		logger.info(
			f'TCD output directory contents: {exec_result.output.decode()}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		# Look for any segmentation output files (TCD generates multiple tile files)
		# Use shell command to handle pipes correctly in Alpine container
		exec_result = temp_container.exec_run(
			['sh', '-c', f'ls /tcd_data/{project_name}/output/ | grep segmentation.tif | head -1']
		)
		logger.info(
			f'Segmentation file search result: "{exec_result.output.decode()}" (exit_code: {exec_result.exit_code})',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		if exec_result.exit_code != 0 or not exec_result.output.decode().strip():
			# Fallback: try to get any .tif file using shell
			exec_result = temp_container.exec_run(['sh', '-c', f'ls /tcd_data/{project_name}/output/*.tif | head -1'])
			if exec_result.exit_code != 0 or not exec_result.output.decode().strip():
				raise Exception(f'No segmentation files found in TCD output: /tcd_data/{project_name}/output/')

		# Get the first segmentation file found (need to construct full path)
		filename = exec_result.output.decode().strip()
		if filename.startswith('/'):
			# Already has full path
			first_segmentation_file = filename
		else:
			# Need to construct full path
			first_segmentation_file = f'/tcd_data/{project_name}/output/{filename}'
		logger.info(
			f'Using segmentation file: {first_segmentation_file}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		# Get segmentation file from container
		archive_stream, _ = temp_container.get_archive(first_segmentation_file)

		# Extract segmentation file to local directory and rename to confidence_map.tif for compatibility
		with tarfile.open(mode='r|', fileobj=io.BytesIO(b''.join(archive_stream))) as tar:
			tar.extractall(local_output_dir)

		# Rename the extracted file to confidence_map.tif for API compatibility
		extracted_files = list(local_output_dir.glob('*segmentation.tif'))
		if extracted_files:
			extracted_files[0].rename(confidence_map_path)

		logger.info(
			f'Successfully copied confidence map to {confidence_map_path}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		return str(confidence_map_path)

	except Exception as e:
		logger.error(
			f'Failed to copy TCD results from volume: {str(e)}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)
		raise
	finally:
		if temp_container:
			try:
				temp_container.remove(force=True)
			except Exception as cleanup_error:
				logger.warning(
					f'Failed to cleanup TCD extraction container: {cleanup_error}',
					LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
				)


def _load_confidence_map_from_container_output(confidence_map_path: str) -> np.ndarray:
	"""
	Load confidence map from TCD container output file.

	This replaces the original confidence map type detection logic with
	a simple file-based approach since we know the container outputs a GeoTIFF.

	Args:
	    confidence_map_path (str): Path to confidence_map.tif from TCD container

	Returns:
	    np.ndarray: Confidence map as numpy array
	"""
	with rasterio.open(confidence_map_path) as src:
		return src.read(1)  # Read first band as numpy array


def _cleanup_tcd_volume(volume_name: str, dataset_id: int, token: str):
	"""
	Clean up TCD shared volume after processing.

	Args:
	    volume_name (str): Docker volume name to remove
	    dataset_id (int): Dataset ID for logging
	    token (str): Authentication token for logging
	"""
	client = docker.from_env()

	try:
		client.volumes.get(volume_name).remove()
		logger.info(
			f'TCD shared volume {volume_name} removed successfully',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)
	except Exception as e:
		logger.warning(
			f'Failed to remove TCD shared volume {volume_name}: {str(e)}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)


def predict_treecover(dataset_id: int, file_path: Path, user_id: str, token: str):
	"""
	Hybrid tree cover prediction using TCD container + original processing logic.

	This function implements the hybrid approach:
	1. Preprocess: Reproject orthomosaic to EPSG:3395, 10cm resolution (rasterio)
	2. Container: Execute TCD container via shared volumes
	3. Postprocess: Load confidence map, threshold, convert to polygons (original logic)
	4. Storage: Save to v2_forest_cover_geometries via labels system

	Args:
	    dataset_id (int): Dataset ID
	    file_path (Path): Path to orthomosaic file
	    user_id (str): User ID for label creation
	    token (str): Authentication token
	"""
	volume_name = None
	temp_dir = None

	try:
		# Create temporary directory for processing
		temp_dir = tempfile.mkdtemp(prefix=f'treecover_{dataset_id}_')
		temp_dir_path = Path(temp_dir)

		# Step 1: Preprocess - Reproject orthomosaic using rasterio (replaces convert_to_projected)
		logger.info(
			f'Reprojecting orthomosaic to {TCD_TARGET_CRS} at {TCD_TARGET_RESOLUTION}m resolution',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		reprojected_path = temp_dir_path / 'orthomosaic_reprojected.tif'
		_reproject_orthomosaic_for_tcd(str(file_path), str(reprojected_path))

		# Step 2: Container Setup - Create shared volume and copy reprojected ortho
		volume_name = f'tcd_volume_{dataset_id}_{uuid.uuid4().hex[:8]}'
		client = docker.from_env()
		client.volumes.create(name=volume_name)

		logger.info(
			f'Created TCD shared volume {volume_name}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		# Copy reprojected orthomosaic to shared volume
		container_ortho_path = _copy_ortho_to_tcd_volume(str(reprojected_path), volume_name, dataset_id, token)

		# Step 3: Container Execution - Run TCD container for semantic segmentation
		logger.info(
			'Running TCD container for semantic segmentation',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		container_output_path = _run_tcd_container(volume_name, dataset_id, token)

		# Step 4: Result Extraction - Copy confidence map from volume
		tcd_output_dir = temp_dir_path / 'tcd_output'
		confidence_map_path = _copy_tcd_results_from_volume(volume_name, tcd_output_dir, dataset_id, token)

		# Step 5: Postprocessing - Load confidence map and apply original thresholding logic
		logger.info(
			'Loading confidence map and applying thresholding',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		confidence_map = _load_confidence_map_from_container_output(confidence_map_path)

		# Apply original thresholding logic: (confidence_map > 200).astype(np.uint8)
		outimage = (confidence_map > TCD_THRESHOLD).astype(np.uint8)

		# Step 6: Polygon Conversion - Use existing mask_to_polygons utility
		logger.info(
			'Converting binary mask to polygons',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		# Open the reprojected dataset to get the transform for mask_to_polygons
		with rasterio.open(str(reprojected_path)) as dataset:
			polygons = mask_to_polygons(outimage, dataset)

		if not any(polygons):
			logger.warning(
				'No tree cover polygons detected',
				LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
			)
			return

		# Step 7: Coordinate Reprojection - Reproject from EPSG:3395 back to WGS84
		logger.info(
			f'Reprojecting {len(polygons)} polygons from {TCD_TARGET_CRS} to {TCD_OUTPUT_CRS}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		polygons = reproject_polygons(polygons, TCD_TARGET_CRS, TCD_OUTPUT_CRS)

		# Step 8: Database Storage - Convert to GeoJSON and save via labels system
		logger.info(
			'Converting polygons to GeoJSON format for database storage',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		# Convert polygons to GeoJSON MultiPolygon format
		treecover_geojson = {
			'type': 'MultiPolygon',
			'coordinates': [
				[[[float(x), float(y)] for x, y in poly.exterior.coords]]
				+ [[[float(x), float(y)] for x, y in interior.coords] for interior in poly.interiors]
				for poly in polygons
			],
		}

		# Create label payload
		payload = LabelPayloadData(
			dataset_id=dataset_id,
			label_source=LabelSourceEnum.model_prediction,
			label_type=LabelTypeEnum.semantic_segmentation,
			label_data=LabelDataEnum.forest_cover,
			label_quality=3,
			geometry=treecover_geojson,
			properties={
				'model': TCD_MODEL,
				'threshold': TCD_THRESHOLD,
				'resolution_m': TCD_TARGET_RESOLUTION,
				'processing_crs': TCD_TARGET_CRS,
				'container_version': TCD_CONTAINER_IMAGE,
			},
		)

		# Delete existing tree cover prediction labels
		deleted_count = delete_model_prediction_labels(
			dataset_id=dataset_id, label_data=LabelDataEnum.forest_cover, token=token
		)
		if deleted_count > 0:
			logger.info(
				f'Deleted {deleted_count} existing tree cover prediction labels',
				LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
			)

		# Create label with geometries
		logger.info(
			'Creating label with forest cover geometries',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		label = create_label_with_geometries(payload, user_id, token)

		logger.info(
			f'Successfully created tree cover label {label.id} with {len(polygons)} geometries',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

	except Exception as e:
		logger.error(
			f'Error in predict_treecover: {str(e)}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)
		raise ProcessingError(str(e), task_type='treecover_segmentation', dataset_id=dataset_id)

	finally:
		# Clean up resources
		if volume_name:
			_cleanup_tcd_volume(volume_name, dataset_id, token)

		if temp_dir and os.path.exists(temp_dir):
			import shutil

			shutil.rmtree(temp_dir, ignore_errors=True)
			logger.info(
				f'Cleaned up temporary directory {temp_dir}',
				LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
			)
