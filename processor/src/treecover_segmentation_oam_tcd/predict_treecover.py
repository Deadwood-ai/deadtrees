import tempfile
import os
import json
import time
from pathlib import Path
import numpy as np
import rasterio
import rasterio.warp
from rasterio.windows import Window

from shared.logger import logger
from shared.settings import settings
from shared.models import LabelPayloadData, LabelSourceEnum, LabelTypeEnum, LabelDataEnum
from shared.labels import create_label_with_geometries, delete_model_prediction_labels
from shared.logging import LogContext, LogCategory
from shared.db import login, verify_token
from ..utils.segmentation import (
	mask_to_polygons_scanline,
	reproject_polygons,
	filter_polygons_by_area,
	get_utm_string_from_latlon,
)
from processor.src.utils.debug_artifacts import (
	retain_failed_artifacts_enabled_for_dataset,
	write_debug_bundle,
)
from ..exceptions import ProcessingError, AuthenticationError
from .tcd_inference import TCD_MODEL_REPO, TCD_MODEL_REVISION, TCDModel, predict_confidence_map

# Load configuration
CONFIG_PATH = str(Path(__file__).parent / 'treecover_inference_config.json')
with open(CONFIG_PATH, 'r') as f:
	config = json.load(f)

# TCD configuration
TCD_THRESHOLD = config['tree_cover_threshold']
TCD_MODEL = TCD_MODEL_REPO
TCD_TARGET_RESOLUTION = config['tree_cover_inference_resolution']  # 10cm resolution (forced for all inputs)
TCD_TARGET_CRS = 'EPSG:3395'  # World Mercator - what the TCD model was trained on
TCD_OUTPUT_CRS = 'EPSG:4326'  # WGS84 for database storage
MODULE_NAME = 'treecover_segmentation_oam_tcd'
CHECKPOINT_NAME = TCD_MODEL



MINIMUM_POLYGON_AREA = config['minimum_polygon_area']


def _reproject_orthomosaic_for_tcd(input_tif: str, output_path: str) -> str:
	"""
	Reproject orthomosaic to EPSG:3395 (World Mercator) with forced 10cm resolution for TCD.

	The TCD model was trained on EPSG:3395 at 10cm resolution. This function ensures
	all inputs are standardized to match the training conditions, regardless of the
	original CRS or resolution of the input orthomosaic.

	Args:
		input_tif (str): Path to input orthomosaic
		output_path (str): Path for reprojected output file

	Returns:
		str: Path to reprojected file
	"""
	with rasterio.open(input_tif) as src:
		# Calculate transform for EPSG:3395 at forced 10cm resolution
		target_transform, target_width, target_height = rasterio.warp.calculate_default_transform(
			src.crs,
			TCD_TARGET_CRS,
			src.width,
			src.height,
			*src.bounds,
			resolution=TCD_TARGET_RESOLUTION,  # Force 10cm regardless of input resolution
		)

		# Create output profile
		profile = src.profile.copy()
		profile.update(
			{
				'crs': TCD_TARGET_CRS,
				'transform': target_transform,
				'width': target_width,
				'height': target_height,
				'nodata': 0,
				'BIGTIFF': 'YES',
			}
		)

		# Reproject the image to EPSG:3395. Warping in parallel gives the same pixels
		# as a single thread (each output chunk is computed independently).
		with rasterio.open(output_path, 'w', **profile) as dst:
			for i in range(1, src.count + 1):
				rasterio.warp.reproject(
					source=rasterio.band(src, i),
					destination=rasterio.band(dst, i),
					src_transform=src.transform,
					src_crs=src.crs,
					dst_transform=target_transform,
					dst_crs=TCD_TARGET_CRS,
					resampling=rasterio.warp.Resampling.bilinear,
					num_threads=os.cpu_count() or 1,
				)

	return output_path


def predict_treecover(dataset_id: int, file_path: Path, user_id: str, token: str):
	"""
	Tree cover prediction with the TCD SegFormer model, run in-process.

	1. Preprocess: Reproject orthomosaic to EPSG:3395 at 10cm (TCD requires metric CRS, not degrees)
	2. Inference: Tile the reprojected ortho and write the tree confidence map (see tcd_inference)
	3. Postprocess: Load confidence map, apply nodata mask, threshold, filter polygons
	4. Storage: Convert to EPSG:4326 and save to v2_forest_cover_geometries via labels system

	Args:
		dataset_id (int): Dataset ID
		file_path (Path): Path to original orthomosaic file
		user_id (str): User ID for label creation
		token (str): Authentication token
	"""
	temp_dir = None
	had_error = False
	retain_on_failure = retain_failed_artifacts_enabled_for_dataset(dataset_id)

	try:
		# Create temporary directory for processing
		temp_dir = tempfile.mkdtemp(prefix=f'treecover_{dataset_id}_')
		temp_dir_path = Path(temp_dir)

		# Step 1: Preprocess - reproject orthomosaic to EPSG:3395 for TCD
		# This is necessary because TCD expects metric CRS, not geographic (degrees)
		reprojected_temp_path = temp_dir_path / 'reprojected_orthomosaic.tif'
		logger.info(
			f'Reprojecting orthomosaic to EPSG:3395 for TCD: {file_path} -> {reprojected_temp_path}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)
		reprojected_path = Path(_reproject_orthomosaic_for_tcd(str(file_path), str(reprojected_temp_path)))

		# Step 2: Inference - write the uint8 tree confidence map on the reprojected grid
		confidence_map_path = temp_dir_path / 'confidence_map.tif'
		model = TCDModel()
		logger.info(
			f'Running TCD inference on {model.device.type}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)
		started = time.time()
		try:
			result = predict_confidence_map(reprojected_path, confidence_map_path, model)
		finally:
			model.close()
		logger.info(
			f'TCD inference finished in {time.time() - started:.1f}s: {result.processed_tiles} tiles predicted, '
			f'{result.skipped_tiles} empty tiles skipped ({result.device})',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		# Inference can outlive the JWT on very large orthos.
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

		# Step 5: Postprocessing - threshold the confidence map and apply the nodata
		# mask, writing the binary result to a temporary GeoTIFF block-by-block.
		#
		# The TCD confidence map is gigapixel-scale (e.g. ~40000x22000 px for a
		# typical drone ortho). The previous approach loaded the whole confidence
		# array, the full thresholded array AND the full dataset mask at once — plus
		# the float64 temporary that ``mask / 255`` created — peaking at many GB and
		# OOM-killing the worker mid-step (SIGKILLed, so nothing was ever logged).
		# We now stream block-by-block to a binary mask GeoTIFF and polygonize it
		# with ``mask_to_polygons_scanline`` (the same memory-safe path the deadwood,
		# combined and AOI models already use), so no full-resolution array is ever
		# held in memory — peak usage stays proportional to a single window.
		logger.info(
			'Loading confidence map and applying thresholding',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)
		logger.info(
			'Applying nodata mask processing to filter invalid areas',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		treecover_mask_path = temp_dir_path / 'treecover_mask.tif'
		with rasterio.open(confidence_map_path) as confidence_src:
			height = confidence_src.height
			width = confidence_src.width

			# For internally tiled GeoTIFFs, iterate the native tiles. For non-tiled
			# (striped) files block_windows yields one window per strip — often a
			# single row — which is correct but means tens of thousands of tiny
			# reads on a gigapixel raster; coalesce those into 2048-row strips
			# instead. Either way peak memory stays proportional to one window.
			if confidence_src.is_tiled:
				windows = [window for _, window in confidence_src.block_windows(1)]
			else:
				strip_height = 2048
				windows = [
					Window(0, row, width, min(strip_height, height - row))
					for row in range(0, height, strip_height)
				]

			mask_profile = confidence_src.profile.copy()
			mask_profile.update(
				count=1, dtype='uint8', nodata=None,
				compress='LZW', tiled=True, blockxsize=512, blockysize=512,
			)

			# Pass 1: threshold each confidence block straight into the output
			# GeoTIFF and record which nodata mask values appear, without ever
			# materialising a full-resolution array.
			mask_values_seen: set[int] = set()
			with rasterio.open(treecover_mask_path, 'w', **mask_profile) as mask_dst:
				for window in windows:
					confidence_block = confidence_src.read(1, window=window)
					mask_dst.write((confidence_block > TCD_THRESHOLD).astype(np.uint8), 1, window=window)
					mask_values_seen.update(np.unique(confidence_src.dataset_mask(window=window)).tolist())

			# Only apply masking if the mask is strictly binary (values ⊆ {0, 255}).
			# The block-wise pass zeros pixels where mask == 0, which is only correct
			# for a true binary nodata mask; partial-alpha masks (e.g. {0, 128}) are
			# left untouched to avoid masking artifacts.
			unique_mask_values = sorted(mask_values_seen)
			if mask_values_seen and mask_values_seen.issubset({0, 255}):
				# Pass 2: zero out fully-transparent (mask == 0) pixels block-by-block,
				# reading and writing the output GeoTIFF in place.
				with rasterio.open(treecover_mask_path, 'r+') as mask_dst:
					for window in windows:
						mask_block = confidence_src.dataset_mask(window=window)
						out_block = mask_dst.read(1, window=window)
						out_block[mask_block == 0] = 0
						mask_dst.write(out_block, 1, window=window)
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

		# Step 6: Polygon Conversion - polygonize the binary mask GeoTIFF scanline by
		# scanline so the full raster is never loaded into memory.
		logger.info(
			'Converting binary mask to polygons',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)

		with rasterio.open(str(treecover_mask_path)) as dataset:
			polygons = mask_to_polygons_scanline(dataset, 1)

		if len(polygons) == 0:
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
		if len(polygons) == 0:
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

		# Step 6.5: Validate and fix geometries before saving (CRITICAL for frontend performance)
		logger.info(
			'Validating and fixing geometries before database storage',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)
		from processor.src.utils.geometry_validation import validate_and_fix_polygons

		polygons, validation_stats = validate_and_fix_polygons(
			polygons, min_area=0.0, dataset_id=dataset_id, label_type='treecover'
		)

		if len(polygons) == 0:
			logger.warning(
				'No valid tree cover polygons after geometry validation',
				LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
			)
			return

		# Step 7: Database Storage - Convert to GeoJSON and save via labels system
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
			model_metadata={
				'module': MODULE_NAME,
				'checkpoint_name': CHECKPOINT_NAME,
			},
			geometry=treecover_geojson,
			properties={
				'model': TCD_MODEL,
				'threshold': TCD_THRESHOLD,
				'resolution_m': actual_resolution_m,
				'processing_crs': source_crs.to_string() if source_crs else None,
				'model_revision': TCD_MODEL_REVISION,
			},
		)

		# Refresh token before database operations to avoid expiry after long inference
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		user = verify_token(token)
		if not user:
			logger.error(
				'Token refresh failed during treecover database operations',
				LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
			)
			raise AuthenticationError('Token refresh failed', dataset_id=dataset_id)

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
		had_error = True
		logger.error(
			f'Error in predict_treecover: {str(e)}',
			LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
		)
		# Best-effort: persist a minimal debug bundle for the failure.
		try:
			write_debug_bundle(
				forensics={
					'dataset_id': dataset_id,
					'stage': 'treecover',
					'error': str(e),
					'temp_dir': temp_dir,
				},
				token=token,
				dataset_id=dataset_id,
				stage='treecover',
			)
		except Exception:
			pass
		raise ProcessingError(str(e), task_type='treecover_segmentation', dataset_id=dataset_id)

	finally:
		# Clean up resources
		if temp_dir and os.path.exists(temp_dir):
			import shutil

			if had_error and retain_on_failure:
				logger.warning(
					f'Retaining treecover temp directory for debugging (DT_RETAIN_FAILED_ARTIFACTS enabled): {temp_dir}',
					LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
				)
			else:
				shutil.rmtree(temp_dir, ignore_errors=True)
				logger.info(
					f'Cleaned up temporary directory {temp_dir}',
					LogContext(category=LogCategory.TREECOVER, token=token, dataset_id=dataset_id),
				)
