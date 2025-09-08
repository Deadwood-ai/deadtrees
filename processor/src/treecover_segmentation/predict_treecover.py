import tempfile
import os
import uuid
import json
from pathlib import Path
import numpy as np
import rasterio
import rasterio.warp
import docker
import tarfile
import io

from shared.logger import logger
from shared.settings import settings
from shared.models import LabelPayloadData, LabelSourceEnum, LabelTypeEnum, LabelDataEnum
from shared.labels import create_label_with_geometries, delete_model_prediction_labels
from shared.logging import LogContext, LogCategory
from ..deadwood_segmentation.deadtreesmodels.common.common import (
	mask_to_polygons,
	reproject_polygons,
	filter_polygons_by_area,
	get_utm_string_from_latlon,
)
from processor.src.utils.shared_volume import cleanup_volume_and_references
from ..exceptions import ProcessingError

# Load configuration
CONFIG_PATH = str(Path(__file__).parent / 'treecover_inference_config.json')
with open(CONFIG_PATH, 'r') as f:
	config = json.load(f)

# TCD configuration
TCD_THRESHOLD = config['tree_cover_threshold']
TCD_MODEL = 'restor/tcd-segformer-mit-b5'
TCD_TARGET_RESOLUTION = config['tree_cover_inference_resolution']  # nominal resolution guideline
TCD_OUTPUT_CRS = 'EPSG:4326'  # WGS84 for database storage
TCD_CONTAINER_IMAGE = settings.TCD_CONTAINER_IMAGE  # Our local TCD container
MINIMUM_POLYGON_AREA = config['minimum_polygon_area']


## Note: Pre-inference reprojection is not required by TCD and has been removed.


def _copy_files_to_tcd_volume(ortho_path: str, volume_name: str, dataset_id: int, token: str) -> tuple[str, str]:
	"""
	Copy reprojected orthomosaic and pipeline script to TCD shared volume.

	Args:
	    ortho_path (str): Path to reprojected orthomosaic file
	    volume_name (str): Docker volume name
	    dataset_id (int): Dataset ID for directory structure
	    token (str): Authentication token for logging

	Returns:
	    tuple[str, str]: Container paths to (orthomosaic, confidence_map_output)
	"""
	client = docker.from_env()
	project_name = f'dataset_{dataset_id}'
	container_ortho_path = f'/tcd_data/{project_name}/input/orthomosaic.tif'
	container_confidence_path = f'/tcd_data/{project_name}/output/confidence_map.tif'

	logger.info(
		'Copying files to TCD shared volume',
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

		# Create TCD directory structure
		exec_result = temp_container.exec_run(
			f'mkdir -p /tcd_data/{project_name}/input /tcd_data/{project_name}/output'
		)
		if exec_result.exit_code != 0:
			raise Exception(f'Failed to create TCD directory structure: {exec_result.output.decode()}')

		# Copy orthomosaic file (stream to avoid loading entire file in memory)
		ortho_file = Path(ortho_path)

		# Copy pipeline script
		pipeline_script_path = Path(__file__).parent / 'predict_pipeline.py'
		with open(pipeline_script_path, 'rb') as f:
			script_data = f.read()

		# Create tar archive with both files
		tar_buffer = io.BytesIO()
		with tarfile.open(mode='w', fileobj=tar_buffer) as tar:
			# Add orthomosaic (streamed)
			ortho_info = tarfile.TarInfo(name='orthomosaic.tif')
			ortho_info.size = ortho_file.stat().st_size
			with open(ortho_file, 'rb') as of:
				tar.addfile(ortho_info, of)

			# Add pipeline script
			script_info = tarfile.TarInfo(name='predict_pipeline.py')
			script_info.size = len(script_data)
			tar.addfile(script_info, io.BytesIO(script_data))

		tar_buffer.seek(0)
		temp_container.put_archive(f'/tcd_data/{project_name}/input/', tar_buffer.getvalue())

		# Copy script to root of volume for entrypoint access
		script_tar_buffer = io.BytesIO()
		with tarfile.open(mode='w', fileobj=script_tar_buffer) as tar:
			script_info = tarfile.TarInfo(name='predict_pipeline.py')
			script_info.size = len(script_data)
			tar.addfile(script_info, io.BytesIO(script_data))

		script_tar_buffer.seek(0)
		temp_container.put_archive('/tcd_data/', script_tar_buffer.getvalue())

		logger.info(
			'Successfully copied files to TCD volume',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		return container_ortho_path, container_confidence_path

	except Exception as e:
		logger.error(
			f'Failed to copy files to TCD volume: {str(e)}',
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


def _run_tcd_pipeline_container(volume_name: str, dataset_id: int, token: str) -> str:
	"""
	Execute TCD container using Pipeline class via Python script for complete confidence map output.

	Args:
	    volume_name (str): Docker volume name
	    dataset_id (int): Dataset ID
	    token (str): Authentication token for logging

	Returns:
	    str: Container path to confidence map output file
	"""
	client = docker.from_env()
	project_name = f'dataset_{dataset_id}'
	input_path = f'/tcd_data/{project_name}/input/orthomosaic.tif'
	output_path = f'/tcd_data/{project_name}/output/confidence_map.tif'

	logger.info(
		f'Starting TCD Pipeline container execution for dataset {dataset_id}',
		LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
	)

	try:
		# Preflight: ensure image exists
		try:
			client.images.get(TCD_CONTAINER_IMAGE)
		except Exception as e:
			raise Exception(f'TCD container image {TCD_CONTAINER_IMAGE} not found. Build or pull it. Error: {e}')

		def _run(device_requests=None):
			return client.containers.run(
				image=TCD_CONTAINER_IMAGE,
				command=['python', '/tcd_data/predict_pipeline.py', input_path, output_path],
				entrypoint='',
				volumes={volume_name: {'bind': '/tcd_data', 'mode': 'rw'}},
				remove=True,
				detach=False,
				user='root',
				device_requests=device_requests,
			)

		try:
			container_output = _run(device_requests=[docker.types.DeviceRequest(count=-1, capabilities=[['gpu']])])
		except Exception as gpu_err:
			logger.warning(
				f'GPU execution failed for TCD container, retrying on CPU: {gpu_err}',
				LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
			)
			container_output = _run(device_requests=None)

		logger.info(
			'TCD Pipeline container execution completed successfully',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		# Log container output for debugging
		if container_output:
			logger.info(
				f'TCD Pipeline output: {container_output.decode("utf-8").strip()}',
				LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
			)

		return output_path

	except Exception as e:
		logger.error(
			f'TCD Pipeline container execution failed: {str(e)}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)
		raise


def _copy_confidence_map_from_volume(volume_name: str, local_output_dir: Path, dataset_id: int, token: str) -> str:
	"""
	Copy TCD Pipeline confidence map from shared volume to local directory.

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
	container_confidence_path = f'/tcd_data/{project_name}/output/confidence_map.tif'

	logger.info(
		f'Copying TCD Pipeline confidence map from shared volume to {local_output_dir}',
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

		# List all files in the output directory for debugging
		exec_result = temp_container.exec_run(f'ls -la /tcd_data/{project_name}/output/')
		logger.info(
			f'TCD output directory contents: {exec_result.output.decode()}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		# Check if confidence_map.tif exists
		exec_result = temp_container.exec_run(f'test -f {container_confidence_path}')
		if exec_result.exit_code != 0:
			raise Exception(f'Confidence map not found at: {container_confidence_path}')

		logger.info(
			f'Found confidence map at: {container_confidence_path}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		# Get confidence map file from container
		archive_stream, _ = temp_container.get_archive(container_confidence_path)

		# Extract confidence map to local directory
		with tarfile.open(mode='r|', fileobj=io.BytesIO(b''.join(archive_stream))) as tar:
			tar.extractall(local_output_dir)

		logger.info(
			f'Successfully copied confidence map to {confidence_map_path}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		return str(confidence_map_path)

	except Exception as e:
		logger.error(
			f'Failed to copy confidence map from volume: {str(e)}',
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
	Tree cover prediction using TCD Pipeline class in container for complete confidence map.

	This function implements the Pipeline-based approach:
	1. Preprocess: Reproject orthomosaic using image_reprojector approach
	2. Container: Execute TCD Pipeline class to generate single complete confidence map
	3. Postprocess: Load confidence map, apply nodata mask, threshold, filter polygons
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

		# Step 1: Preprocess - no reprojection required; use standardized orthomosaic as-is
		reprojected_path = file_path

		# Step 2: Container Setup - Create shared volume and copy reprojected ortho
		volume_name = f'tcd_volume_{dataset_id}_{uuid.uuid4().hex[:8]}'
		client = docker.from_env()
		client.volumes.create(name=volume_name)

		logger.info(
			f'Created TCD shared volume {volume_name}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		# Copy orthomosaic and pipeline script to shared volume
		container_ortho_path, container_confidence_path = _copy_files_to_tcd_volume(
			str(reprojected_path), volume_name, dataset_id, token
		)

		# Step 3: Container Execution - Run TCD Pipeline container for complete confidence map
		logger.info(
			'Running TCD Pipeline container for complete confidence map generation',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		_run_tcd_pipeline_container(volume_name, dataset_id, token)

		# Step 4: Result Extraction - Copy confidence map from volume
		tcd_output_dir = temp_dir_path / 'tcd_output'
		confidence_map_path = _copy_confidence_map_from_volume(volume_name, tcd_output_dir, dataset_id, token)

		# Step 5: Postprocessing - Load confidence map and apply original thresholding logic
		logger.info(
			'Loading confidence map and applying thresholding',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		confidence_map = _load_confidence_map_from_container_output(confidence_map_path)

		# Apply original thresholding logic: (confidence_map > 200).astype(np.uint8)
		outimage = (confidence_map > TCD_THRESHOLD).astype(np.uint8)

		# Step 5.1: Apply nodata mask processing (critical for avoiding tile artifacts)
		logger.info(
			'Applying nodata mask processing to filter invalid areas',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		# Open reprojected dataset to get nodata mask
		with rasterio.open(confidence_map_path) as confidence_src:
			# Get the dataset mask from confidence map
			nodata_mask = confidence_src.dataset_mask()

			# Only apply masking if the mask is standard (contains only 0 and 255)
			unique_mask_values = np.unique(nodata_mask)
			if len(unique_mask_values) <= 2 and (0 in unique_mask_values or 255 in unique_mask_values):
				# Standard mask with 0 and 255 values - apply it
				outimage = outimage * (nodata_mask / 255).astype(np.uint8)
				logger.info(
					f'Applied standard nodata mask with values: {unique_mask_values}',
					LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
				)
			else:
				# Non-standard mask with values all over the place - skip masking
				logger.warning(
					f'Non-standard mask detected with values: {unique_mask_values} - skipping masking operation to avoid artifacts',
					LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
				)

		# Step 6: Polygon Conversion - Use existing mask_to_polygons utility
		logger.info(
			'Converting binary mask to polygons',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		# Use the confidence map dataset to get the transform for mask_to_polygons
		with rasterio.open(str(confidence_map_path)) as dataset:
			polygons = mask_to_polygons(outimage, dataset)

		if not any(polygons):
			logger.warning(
				'No tree cover polygons detected',
				LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
			)
			return

		# Choose metric CRS for area filtering, then reproject to WGS84
		logger.info(
			'Preparing polygons for area filtering and reprojection',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		with rasterio.open(str(confidence_map_path)) as dataset:
			source_crs = dataset.crs
			bounds = dataset.bounds
			center_x = (bounds.left + bounds.right) / 2.0
			center_y = (bounds.bottom + bounds.top) / 2.0

		# Select area CRS
		area_crs = None
		try:
			if source_crs and not source_crs.is_geographic:
				area_crs = source_crs.to_string()
			else:
				area_crs = get_utm_string_from_latlon(center_y, center_x)
		except Exception:
			area_crs = source_crs.to_string() if source_crs else 'EPSG:3857'

		if area_crs and source_crs and area_crs != source_crs.to_string():
			polygons = reproject_polygons(polygons, source_crs, area_crs)

		logger.info(
			f'Filtering {len(polygons)} polygons by minimum area of {MINIMUM_POLYGON_AREA}m²',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)
		polygons = filter_polygons_by_area(polygons, MINIMUM_POLYGON_AREA)
		if not any(polygons):
			logger.warning(
				'No tree cover polygons detected after area filtering',
				LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
			)
			return

		# Reproject to WGS84 for storage
		if area_crs:
			polygons = reproject_polygons(polygons, area_crs, TCD_OUTPUT_CRS)
		else:
			polygons = reproject_polygons(polygons, source_crs, TCD_OUTPUT_CRS)

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
		# Derive actual output resolution from the confidence map dataset to record in properties
		with rasterio.open(str(confidence_map_path)) as dataset:
			out_xres, out_yres = dataset.res
			actual_resolution_m = float(max(abs(out_xres), abs(out_yres)))

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
				'resolution_m': actual_resolution_m,
				'processing_crs': source_crs.to_string() if source_crs else None,
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
			try:
				cleanup_volume_and_references(volume_name, token, dataset_id)
			except Exception:
				_cleanup_tcd_volume(volume_name, dataset_id, token)

		if temp_dir and os.path.exists(temp_dir):
			import shutil

			shutil.rmtree(temp_dir, ignore_errors=True)
			logger.info(
				f'Cleaned up temporary directory {temp_dir}',
				LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
			)
