#!/usr/bin/env python3
"""
Export reference patches as 1024x1024 GeoTIFF images in UTM projection.

This script:
1. Queries the database for patches with status='good'
2. Downloads COGs via nginx
3. Validates patches are square with correct dimensions
4. Crops and resamples to exact patch boundaries (1024x1024 pixels)
5. Exports GeoTIFF (RGB ortho + binary masks) + JSON sidecar files in UTM projection

IMPORTANT: UTM Storage
- Patches are stored in UTM coordinates (not Web Mercator)
- Each patch has an associated epsg_code field (e.g., 32632 for UTM Zone 32N)
- UTM provides true ground measurements in meters with no distortion
- A 204.8m × 204.8m patch is exactly that size on the ground
- No geodesic correction needed

Benefits of UTM Export:
✅ No distortion - true ground measurements
✅ Perfectly square patches (exact dimensions)
✅ Consistent dimensions regardless of latitude
✅ Same ground resolution accuracy

Usage:
	python scripts/export_ml_tiles.py --output-dir ml_ready_tiles
	python scripts/export_ml_tiles.py --output-dir /path/to/export --dataset-id 946
	python scripts/export_ml_tiles.py --output-dir ml_ready_tiles --resolution 10
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Optional
import tempfile
import urllib.request
import os

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import from_bounds
from rasterio.features import rasterize
from rasterio.transform import from_bounds as transform_from_bounds
from rasterio.vrt import WarpedVRT
from tqdm import tqdm
from shapely.geometry import shape, box
from shapely.ops import transform
from pyproj import Transformer

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from shared.db import login, use_client
from shared.settings import settings

# Default credentials (can be overridden via CLI or env vars)
DEFAULT_EMAIL = 'processor@deadtrees.earth'
DEFAULT_PASSWORD = 'processor'


def get_nginx_cog_url(cog_path: str, base_url: str = 'http://localhost:8080/cogs/v1') -> str:
	"""Construct nginx URL for COG file.

	Args:
		cog_path: COG filename from database (e.g., '426_cog.tif')
		base_url: Base URL for nginx COG endpoint

	Returns:
		str: Full URL to COG file
	"""
	return f'{base_url}/{cog_path}'


def download_cog_to_temp(cog_url: str) -> Path:
	"""Download COG file to temporary location.

	Args:
		cog_url: Full URL to COG file

	Returns:
		Path: Path to downloaded temporary file

	Raises:
		Exception: If download fails
	"""
	temp_file = Path(tempfile.mktemp(suffix='.tif'))

	try:
		urllib.request.urlretrieve(cog_url, temp_file)
		return temp_file
	except Exception as e:
		if temp_file.exists():
			temp_file.unlink()
		raise Exception(f'Failed to download COG from {cog_url}: {e}')


def validate_tile_bounds(tile_bbox: tuple, cog_bounds: tuple, dataset_id: int, tile_index: str) -> bool:
	"""Check if tile bounds are fully within COG bounds.

	Args:
		tile_bbox: (minx, miny, maxx, maxy) for tile
		cog_bounds: (left, bottom, right, top) from COG
		dataset_id: Dataset ID for error message
		tile_index: Tile index for error message

	Returns:
		bool: True if valid, False if tile extends outside COG
	"""
	minx, miny, maxx, maxy = tile_bbox
	left, bottom, right, top = cog_bounds

	if minx < left or miny < bottom or maxx > right or maxy > top:
		print(f'⚠️  Tile {tile_index} (dataset {dataset_id}) extends outside COG bounds - skipping')
		return False

	return True


def export_patch_geotiff(
	token: str,
	cog_path_local: Path,
	patch: dict,
	output_dir: Path,
	target_gsd_m: float,
	cog_info: dict,
	aoi_geometry: Optional[dict],
) -> Optional[Path]:
	"""Export a single patch as 1024x1024 GeoTIFF in UTM projection with JSON metadata and prediction masks.

	Args:
		token: Authentication token
		cog_path_local: Path to local COG file
		patch: Patch record from database (from reference_patches table)
		output_dir: Output directory for GeoTIFF files
		target_gsd_m: Target ground sample distance in meters
		cog_info: COG info from database
		aoi_geometry: AOI GeoJSON geometry

	Returns:
		Path to exported GeoTIFF file, or None if export failed
	"""
	dataset_id = patch['dataset_id']
	patch_index = patch['patch_index']
	patch_id = patch['id']
	resolution_cm = patch['resolution_cm']
	epsg_code = patch['epsg_code']
	utm_zone = patch.get('utm_zone')

	# Validate EPSG code exists
	if not epsg_code:
		print(f'❌ Patch {patch_index}: Missing epsg_code field')
		return None

	# Extract bounding box in UTM coordinates
	minx_utm = patch['bbox_minx']
	miny_utm = patch['bbox_miny']
	maxx_utm = patch['bbox_maxx']
	maxy_utm = patch['bbox_maxy']

	# Note: We'll validate bounds after opening the COG with WarpedVRT in UTM projection
	# This way we can compare UTM coordinates directly

	# Calculate patch center in WGS84 (for metadata only)
	center_x_utm = (minx_utm + maxx_utm) / 2.0
	center_y_utm = (miny_utm + maxy_utm) / 2.0
	transformer_to_wgs84 = Transformer.from_crs(f'EPSG:{epsg_code}', 'EPSG:4326', always_xy=True)
	center_lon, center_lat = transformer_to_wgs84.transform(center_x_utm, center_y_utm)

	# Calculate UTM dimensions (should be exact!)
	bbox_width_utm = maxx_utm - minx_utm
	bbox_height_utm = maxy_utm - miny_utm

	# Validate patch is square (should be perfect in UTM)
	size_difference = abs(bbox_width_utm - bbox_height_utm)
	if size_difference > 0.1:  # Allow 10cm tolerance
		print(f'❌ Patch {patch_index}: Not square! {bbox_width_utm:.2f}m × {bbox_height_utm:.2f}m')
		print(f'   Difference: {size_difference:.2f}m (expected: perfectly square)')
		return None

	# Validate expected size (204.8m for 20cm, 102.4m for 10cm, 51.2m for 5cm)
	expected_size = target_gsd_m * 1024.0
	avg_size = (bbox_width_utm + bbox_height_utm) / 2.0
	size_error = abs(avg_size - expected_size)

	if size_error > 1.0:  # Allow 1m tolerance
		print(f'❌ Patch {patch_index}: Size mismatch! Expected {expected_size:.2f}m, got {avg_size:.2f}m')
		print(f'   Error: {size_error:.2f}m')
		return None

	try:
		with rasterio.open(cog_path_local) as src:
			# Wrap COG in a WarpedVRT to reproject it to UTM on-the-fly
			# This avoids coordinate transformation artifacts and ensures perfect alignment
			with WarpedVRT(
				src,
				crs=f'EPSG:{epsg_code}',  # Target UTM projection
				resampling=Resampling.bilinear,
			) as vrt:
				# Now we can read directly using UTM coordinates!
				# The VRT handles the reprojection transparently

				# Validate patch is within VRT bounds (now in UTM)
				vrt_bounds = vrt.bounds  # left, bottom, right, top in UTM
				if not validate_tile_bounds(
					(minx_utm, miny_utm, maxx_utm, maxy_utm), vrt_bounds, dataset_id, patch_index
				):
					return None

				# Create window from UTM bounds
				window = from_bounds(minx_utm, miny_utm, maxx_utm, maxy_utm, vrt.transform)

				# Read RGB bands with resampling to exact 1024x1024
				data = vrt.read(
					indexes=[1, 2, 3], window=window, out_shape=(3, 1024, 1024), resampling=Resampling.bilinear
				)

		# Check data shape
		if data.shape != (3, 1024, 1024):
			print(f'❌ Patch {patch_index}: Invalid data shape {data.shape}, expected (3, 1024, 1024)')
			return None

		# Create AOI mask (in UTM coordinates)
		bbox_tuple_utm = (minx_utm, miny_utm, maxx_utm, maxy_utm)
		aoi_mask = create_aoi_mask(aoi_geometry, bbox_tuple_utm, epsg_code)

		# Apply AOI mask to RGB image (set to black outside AOI)
		aoi_mask_3d = np.expand_dims(aoi_mask, axis=2)
		aoi_mask_broadcast = np.broadcast_to(aoi_mask_3d, (1024, 1024, 3))
		img_data_masked = np.moveaxis(data, 0, -1) * aoi_mask_broadcast

		# Move back to CHW format for rasterio
		rgb_data = np.moveaxis(img_data_masked, -1, 0).astype(np.uint8)

		# Fetch and rasterize deadwood reference geometries
		# For child patches without their own labels, inherit from parent hierarchy
		deadwood_mask = None
		deadwood_label_id = patch.get('reference_deadwood_label_id')
		forestcover_label_id = patch.get('reference_forest_cover_label_id')

		# If this patch doesn't have label IDs, recursively search parent hierarchy
		if (not deadwood_label_id or not forestcover_label_id) and patch.get('parent_tile_id'):
			parent_labels = fetch_parent_label_ids(token, patch['parent_tile_id'])
			if not deadwood_label_id:
				deadwood_label_id = parent_labels['deadwood']
			if not forestcover_label_id:
				forestcover_label_id = parent_labels['forestcover']

		# Fetch and rasterize deadwood geometries
		if deadwood_label_id:
			deadwood_geoms = fetch_geometries_by_label(
				token, deadwood_label_id, 'reference_patch_deadwood_geometries', bbox_tuple_utm, epsg_code
			)
			if deadwood_geoms:
				deadwood_mask = rasterize_geometries(deadwood_geoms, bbox_tuple_utm)
				# Apply AOI mask and convert to binary 0/1 (not 0/255)
				deadwood_mask = ((deadwood_mask > 0) * aoi_mask).astype(np.uint8)

		# Fetch and rasterize forest cover geometries
		forestcover_mask = None
		if forestcover_label_id:
			forestcover_geoms = fetch_geometries_by_label(
				token, forestcover_label_id, 'reference_patch_forest_cover_geometries', bbox_tuple_utm, epsg_code
			)
			if forestcover_geoms:
				forestcover_mask = rasterize_geometries(forestcover_geoms, bbox_tuple_utm)
				# Apply AOI mask and convert to binary 0/1 (not 0/255)
				forestcover_mask = ((forestcover_mask > 0) * aoi_mask).astype(np.uint8)

		# Create output filenames
		filename_base = f'{dataset_id}_{patch_index}_{resolution_cm}cm'
		geotiff_path = output_dir / f'{filename_base}.tif'
		json_path = output_dir / f'{filename_base}.json'
		deadwood_path = output_dir / f'{filename_base}_deadwood.tif'
		forestcover_path = output_dir / f'{filename_base}_forestcover.tif'

		# Create UTM transform for the patch
		utm_transform = transform_from_bounds(minx_utm, miny_utm, maxx_utm, maxy_utm, 1024, 1024)

		# Save RGB GeoTIFF in UTM projection
		with rasterio.open(
			geotiff_path,
			'w',
			driver='GTiff',
			height=1024,
			width=1024,
			count=3,
			dtype=np.uint8,
			crs=f'EPSG:{epsg_code}',
			transform=utm_transform,
			compress='DEFLATE',
			tiled=True,
			blockxsize=256,
			blockysize=256,
		) as dst:
			dst.write(rgb_data)

		# Save deadwood mask if available
		has_deadwood = False
		if deadwood_mask is not None:
			with rasterio.open(
				deadwood_path,
				'w',
				driver='GTiff',
				height=1024,
				width=1024,
				count=1,
				dtype=np.uint8,
				crs=f'EPSG:{epsg_code}',
				transform=utm_transform,
				compress='DEFLATE',
				tiled=True,
				blockxsize=256,
				blockysize=256,
			) as dst:
				dst.write(deadwood_mask, 1)
			has_deadwood = True

		# Save forest cover mask if available
		has_forestcover = False
		if forestcover_mask is not None:
			with rasterio.open(
				forestcover_path,
				'w',
				driver='GTiff',
				height=1024,
				width=1024,
				count=1,
				dtype=np.uint8,
				crs=f'EPSG:{epsg_code}',
				transform=utm_transform,
				compress='DEFLATE',
				tiled=True,
				blockxsize=256,
				blockysize=256,
			) as dst:
				dst.write(forestcover_mask, 1)
			has_forestcover = True

		# Calculate UTM pixel spacing
		utm_pixel_spacing_x = bbox_width_utm / 1024.0
		utm_pixel_spacing_y = bbox_height_utm / 1024.0

		# Create metadata JSON
		metadata = {
			'dataset_id': dataset_id,
			'patch_id': patch_id,
			'patch_index': patch_index,
			'resolution_cm': resolution_cm,
			'crs': f'EPSG:{epsg_code}',
			'utm_zone': utm_zone,
			'epsg_code': epsg_code,
			'bbox_utm': {
				'minx': minx_utm,
				'miny': miny_utm,
				'maxx': maxx_utm,
				'maxy': maxy_utm,
				'width_m': bbox_width_utm,
				'height_m': bbox_height_utm,
			},
			'center_wgs84': {
				'lon': center_lon,
				'lat': center_lat,
			},
			'pixel_spacing_m': {
				'x': utm_pixel_spacing_x,
				'y': utm_pixel_spacing_y,
				'ground_resolution_m': target_gsd_m,
			},
			'target_gsd_m': target_gsd_m,
			'image_size_px': {'width': 1024, 'height': 1024},
			'source_cog_resolution_m_px': cog_info['GEO']['Resolution'][0],
			'has_deadwood_mask': has_deadwood,
			'has_forestcover_mask': has_forestcover,
			'aoi_cropped': aoi_geometry is not None,
			'coverage_stats': {
				'aoi_coverage_percent': patch.get('aoi_coverage_percent'),
				'deadwood_prediction_coverage_percent': patch.get('deadwood_prediction_coverage_percent'),
				'forest_cover_prediction_coverage_percent': patch.get('forest_cover_prediction_coverage_percent'),
			},
			'created_at': patch['created_at']
			if isinstance(patch['created_at'], str)
			else patch['created_at'].isoformat(),
			'user_id': str(patch['user_id']),
		}

		# Save JSON
		with open(json_path, 'w') as f:
			json.dump(metadata, f, indent=2)

		return geotiff_path

	except Exception as e:
		print(f'❌ Error exporting patch {patch_index}: {e}')
		return None


def fetch_aoi_geometry(token: str, dataset_id: int) -> Optional[dict]:
	"""Fetch AOI geometry for a dataset.

	Args:
		token: Authentication token
		dataset_id: Dataset ID

	Returns:
		AOI GeoJSON geometry or None
	"""
	try:
		with use_client(token) as client:
			response = client.from_('v2_aois').select('geometry').eq('dataset_id', dataset_id).execute()

			if response.data and len(response.data) > 0:
				return response.data[0]['geometry']
			return None
	except Exception as e:
		print(f'❌ Error fetching AOI: {e}')
		return None


def fetch_parent_label_ids(token: str, parent_tile_id: int) -> dict:
	"""Recursively fetch label IDs from parent hierarchy.

	For child patches, traverse up the parent tree until we find
	a patch with label_ids set. This handles multi-level hierarchies
	like 5cm → 10cm → 20cm where only the 20cm has labels.

	Args:
		token: Authentication token
		parent_tile_id: Parent tile ID to start searching from

	Returns:
		Dict with 'deadwood' and 'forestcover' label IDs (can be None)
	"""
	label_ids = {'deadwood': None, 'forestcover': None}

	try:
		current_id = parent_tile_id
		max_depth = 5  # Prevent infinite loops
		depth = 0

		while current_id and depth < max_depth:
			with use_client(token) as client:
				response = (
					client.from_('reference_patches')
					.select('id, parent_tile_id, reference_deadwood_label_id, reference_forest_cover_label_id')
					.eq('id', current_id)
					.single()
					.execute()
				)

				if not response.data:
					break

				patch = response.data

				# If we found label IDs, use them
				if patch.get('reference_deadwood_label_id'):
					label_ids['deadwood'] = patch['reference_deadwood_label_id']
				if patch.get('reference_forest_cover_label_id'):
					label_ids['forestcover'] = patch['reference_forest_cover_label_id']

				# If we found both labels or there's no parent, stop
				if (label_ids['deadwood'] and label_ids['forestcover']) or not patch.get('parent_tile_id'):
					break

				# Move up to parent
				current_id = patch.get('parent_tile_id')
				depth += 1

		return label_ids

	except Exception as e:
		print(f'⚠️  Error fetching parent label IDs: {e}')
		return label_ids


def fetch_geometries_by_label(token: str, label_id: int, table_name: str, bbox: tuple, epsg_code: int) -> list:
	"""Fetch reference geometries for a label that intersect with bbox.

	Args:
		token: Authentication token
		label_id: Label ID to fetch geometries for
		table_name: 'reference_patch_deadwood_geometries' or 'reference_patch_forest_cover_geometries'
		bbox: Bounding box (minx, miny, maxx, maxy) in UTM coordinates
		epsg_code: UTM EPSG code (e.g., 32632)

	Returns:
		List of shapely geometries in UTM projection
	"""
	try:
		minx, miny, maxx, maxy = bbox

		# Fetch all geometries for this label
		with use_client(token) as client:
			response = client.from_(table_name).select('geometry').eq('label_id', label_id).execute()

			if not response.data:
				return []

			# Create transformer for EPSG:4326 -> UTM
			transformer = Transformer.from_crs('EPSG:4326', f'EPSG:{epsg_code}', always_xy=True)

			# Convert to shapely geometries, reproject, and filter by bbox
			tile_box = box(minx, miny, maxx, maxy)
			geometries = []

			for row in response.data:
				try:
					# Load geometry from GeoJSON (in EPSG:4326)
					geom_4326 = shape(row['geometry'])

					# Reproject to UTM
					geom_utm = transform(transformer.transform, geom_4326)

					# Check if it intersects with bbox
					if geom_utm.intersects(tile_box):
						geometries.append(geom_utm)
				except Exception:
					# Skip invalid geometries silently
					continue

			return geometries

	except Exception as e:
		print(f'❌ Error fetching geometries by label: {e}')
		import traceback

		traceback.print_exc()
		return []


def fetch_patch_geometries(token: str, patch_id: int, table_name: str, bbox: tuple, epsg_code: int) -> list:
	"""Fetch reference geometries for a patch that intersect with patch bounds.

	DEPRECATED: Use fetch_geometries_by_label instead for better performance.

	Args:
		token: Authentication token
		patch_id: Patch ID from reference_patches table
		table_name: 'reference_patch_deadwood_geometries' or 'reference_patch_forest_cover_geometries'
		bbox: Patch bounding box (minx, miny, maxx, maxy) in UTM coordinates
		epsg_code: UTM EPSG code (e.g., 32632)

	Returns:
		List of shapely geometries in UTM projection
	"""
	try:
		minx, miny, maxx, maxy = bbox

		# Fetch all geometries for this patch
		with use_client(token) as client:
			response = client.from_(table_name).select('geometry').eq('patch_id', patch_id).execute()

			if not response.data:
				return []

			# Create transformer for EPSG:4326 -> UTM
			transformer = Transformer.from_crs('EPSG:4326', f'EPSG:{epsg_code}', always_xy=True)

			# Convert WKB to shapely geometries, reproject, and filter by bbox
			tile_box = box(minx, miny, maxx, maxy)
			geometries = []

			for row in response.data:
				try:
					# Load geometry from GeoJSON (in EPSG:4326)
					geom_4326 = shape(row['geometry'])

					# Reproject to UTM
					geom_utm = transform(transformer.transform, geom_4326)

					# Check if it intersects with tile
					if geom_utm.intersects(tile_box):
						geometries.append(geom_utm)
				except Exception:
					# Skip invalid geometries silently
					continue

			return geometries

	except Exception as e:
		print(f'❌ Error fetching geometries: {e}')
		import traceback

		traceback.print_exc()
		return []


def rasterize_geometries(geometries: list, bbox: tuple, width: int = 1024, height: int = 1024) -> np.ndarray:
	"""Rasterize geometries to a binary mask.

	Args:
		geometries: List of shapely geometries
		bbox: Bounding box (minx, miny, maxx, maxy)
		width: Output width in pixels
		height: Output height in pixels

	Returns:
		Binary mask array (0/255 values)
	"""
	if not geometries:
		return np.zeros((height, width), dtype=np.uint8)

	minx, miny, maxx, maxy = bbox
	transform = transform_from_bounds(minx, miny, maxx, maxy, width, height)

	# Rasterize with value 255 for presence
	mask = rasterize(
		[(geom, 255) for geom in geometries],
		out_shape=(height, width),
		transform=transform,
		fill=0,
		dtype=np.uint8,
		all_touched=True,
	)

	return mask


def create_aoi_mask(
	aoi_geojson: dict, bbox: tuple, epsg_code: int, width: int = 1024, height: int = 1024
) -> np.ndarray:
	"""Create binary mask from AOI geometry.

	Args:
		aoi_geojson: AOI GeoJSON geometry (in EPSG:4326/WGS84)
		bbox: Tile bounding box (minx, miny, maxx, maxy) in UTM coordinates
		epsg_code: UTM EPSG code (e.g., 32632)
		width: Output width in pixels
		height: Output height in pixels

	Returns:
		Binary mask (1 for inside AOI, 0 for outside)
	"""
	if not aoi_geojson:
		return np.ones((height, width), dtype=np.uint8)

	try:
		# Parse AOI geometry (in EPSG:4326)
		aoi_shape = shape(aoi_geojson)

		# Reproject AOI from EPSG:4326 (WGS84) to UTM
		transformer = Transformer.from_crs('EPSG:4326', f'EPSG:{epsg_code}', always_xy=True)
		aoi_shape_utm = transform(transformer.transform, aoi_shape)

		minx, miny, maxx, maxy = bbox
		raster_transform = transform_from_bounds(minx, miny, maxx, maxy, width, height)

		# Rasterize AOI with value 1 for inside
		aoi_mask = rasterize(
			[(aoi_shape_utm, 1)],
			out_shape=(height, width),
			transform=raster_transform,
			fill=0,
			dtype=np.uint8,
			all_touched=False,
		)

		return aoi_mask
	except Exception as e:
		print(f'⚠️  Error creating AOI mask: {e}')
		import traceback

		traceback.print_exc()
		return np.ones((height, width), dtype=np.uint8)


def fetch_good_patches(token: str, dataset_id: Optional[int] = None, resolution_cm: Optional[int] = None) -> list[dict]:
	"""Fetch all patches with status='good' from database.

	Args:
		token: Authentication token
		dataset_id: Optional dataset ID filter
		resolution_cm: Optional resolution filter (5, 10, or 20)

	Returns:
		List of patch records from reference_patches table
	"""
	try:
		with use_client(token) as client:
			query = client.from_('reference_patches').select('*').eq('status', 'good')

			if dataset_id:
				query = query.eq('dataset_id', dataset_id)

			if resolution_cm:
				query = query.eq('resolution_cm', resolution_cm)

			response = query.order('dataset_id').order('resolution_cm').order('patch_index').execute()

			return response.data if response.data else []
	except Exception as e:
		print(f'❌ Error fetching patches: {e}')
		return []


def fetch_cog_info(token: str, dataset_id: int) -> Optional[dict]:
	"""Fetch COG info for a dataset.

	Args:
		token: Authentication token
		dataset_id: Dataset ID

	Returns:
		Dictionary with cog_path and cog_info, or None if not found
	"""
	with use_client(token) as client:
		response = (
			client.from_(settings.cogs_table)
			.select('cog_path, cog_info')
			.eq('dataset_id', dataset_id)
			.single()
			.execute()
		)

		return response.data if response.data else None


def main():
	parser = argparse.ArgumentParser(
		description='Export reference patches as 1024x1024 GeoTIFF images in Web Mercator projection (EPSG:3857)',
		formatter_class=argparse.RawDescriptionHelpFormatter,
		epilog="""
Examples:
  # Export all good patches (uses default credentials)
  python scripts/export_ml_tiles.py --output-dir ml_ready_tiles
  
  # Export with custom credentials via CLI
  python scripts/export_ml_tiles.py --output-dir ml_ready_tiles --user myuser@example.com --password mypassword
  
  # Export with credentials from environment variables
  export DEADTREES_USER=myuser@example.com
  export DEADTREES_PASSWORD=mypassword
  python scripts/export_ml_tiles.py --output-dir ml_ready_tiles
  
  # Export only dataset 946
  python scripts/export_ml_tiles.py --output-dir ml_ready_tiles --dataset-id 946
  
  # Export only 10cm resolution patches
  python scripts/export_ml_tiles.py --output-dir ml_ready_tiles --resolution 10
  
  # Custom nginx endpoint
  python scripts/export_ml_tiles.py --output-dir ml_ready_tiles --nginx-url http://production:8080/cogs/v1
  
  # Dry run to preview what would be exported
  python scripts/export_ml_tiles.py --output-dir ml_ready_tiles --dry-run

Output Files:
  For each patch, the script generates:
  - {dataset_id}_{patch_index}_{resolution}cm.tif - RGB ortho in UTM projection
  - {dataset_id}_{patch_index}_{resolution}cm_deadwood.tif - Binary deadwood mask (0/1)
  - {dataset_id}_{patch_index}_{resolution}cm_forestcover.tif - Binary forest cover mask (0/1)
  - {dataset_id}_{patch_index}_{resolution}cm.json - Metadata with UTM zone and EPSG code

Note: All GeoTIFFs are exported in UTM projection (EPSG code stored in database).
      This ensures correct ground resolution and perfectly square patches with no distortion.

Authentication Priority:
  1. CLI arguments (--user, --password)
  2. Environment variables (DEADTREES_USER, DEADTREES_PASSWORD)
  3. Default credentials (processor@deadtrees.earth)
		""",
	)

	parser.add_argument(
		'--output-dir',
		type=str,
		default='ml_ready_tiles',
		help='Output directory for exported patches (default: ml_ready_tiles)',
	)
	parser.add_argument('--dataset-id', type=int, help='Export patches only for this dataset ID')
	parser.add_argument(
		'--resolution', type=int, choices=[5, 10, 20], help='Export patches only for this resolution (5, 10, or 20 cm)'
	)
	parser.add_argument(
		'--nginx-url',
		type=str,
		default='http://localhost:8080/cogs/v1',
		help='Base URL for nginx COG endpoint (default: http://localhost:8080/cogs/v1)',
	)
	parser.add_argument('--dry-run', action='store_true', help='Show what would be exported without actually exporting')
	parser.add_argument(
		'--user',
		type=str,
		help=f'Database user email (default: env var DEADTREES_USER or {DEFAULT_EMAIL})',
	)
	parser.add_argument(
		'--password',
		type=str,
		help='Database user password (default: env var DEADTREES_PASSWORD or default)',
	)

	args = parser.parse_args()

	# Get credentials from CLI args, environment variables, or defaults
	user_email = args.user or os.getenv('DEADTREES_USER') or DEFAULT_EMAIL
	user_password = args.password or os.getenv('DEADTREES_PASSWORD') or DEFAULT_PASSWORD

	# Authenticate
	print('🔐 Authenticating...')
	print(f'   User: {user_email}')
	try:
		token = login(user_email, user_password)
		print('✓ Authenticated successfully\n')
	except Exception as e:
		print(f'❌ Authentication failed: {e}')
		return 1

	# Create output directory
	output_dir = Path(args.output_dir)
	if not args.dry_run:
		output_dir.mkdir(parents=True, exist_ok=True)
		print(f'📁 Output directory: {output_dir.absolute()}\n')

	# Fetch patches
	print('🔍 Fetching patches from database...')
	patches = fetch_good_patches(token, dataset_id=args.dataset_id, resolution_cm=args.resolution)

	if not patches:
		print('❌ No good patches found matching criteria')
		return 1

	print(f'✓ Found {len(patches)} good patches to export\n')

	# Group patches by dataset and resolution for summary
	by_dataset = {}
	for patch in patches:
		dataset_id = patch['dataset_id']
		resolution = patch['resolution_cm']

		if dataset_id not in by_dataset:
			by_dataset[dataset_id] = {}
		if resolution not in by_dataset[dataset_id]:
			by_dataset[dataset_id][resolution] = 0
		by_dataset[dataset_id][resolution] += 1

	print('📊 Summary:')
	for dataset_id in sorted(by_dataset.keys()):
		resolutions = by_dataset[dataset_id]
		res_str = ', '.join([f'{count}x{res}cm' for res, count in sorted(resolutions.items())])
		print(f'  Dataset {dataset_id}: {res_str}')
	print()

	if args.dry_run:
		print('🔍 Dry run - no files will be exported')
		return 0

	# Export patches
	print('🚀 Exporting patches...')

	# Track COGs and AOI we've already fetched per dataset
	cog_cache: dict[int, tuple[Path, dict]] = {}
	aoi_cache: dict[int, Optional[dict]] = {}

	success_count = 0
	failed_count = 0

	for patch in tqdm(patches, desc='Exporting patches'):
		dataset_id = patch['dataset_id']
		resolution_cm = patch['resolution_cm']

		# GSD mapping
		gsd_map = {20: 0.20, 10: 0.10, 5: 0.05}
		target_gsd = gsd_map[resolution_cm]

		# Get COG info (fetch from DB if not cached)
		if dataset_id not in cog_cache:
			cog_data = fetch_cog_info(token, dataset_id)
			if not cog_data:
				print(f'\n❌ No COG found for dataset {dataset_id}')
				failed_count += 1
				continue

			# Download COG
			cog_url = get_nginx_cog_url(cog_data['cog_path'], args.nginx_url)
			try:
				cog_path_local = download_cog_to_temp(cog_url)
				cog_cache[dataset_id] = (cog_path_local, cog_data['cog_info'])
			except Exception as e:
				print(f'\n❌ Failed to download COG for dataset {dataset_id}: {e}')
				failed_count += 1
				continue

		# Get AOI geometry (fetch from DB if not cached)
		if dataset_id not in aoi_cache:
			aoi_cache[dataset_id] = fetch_aoi_geometry(token, dataset_id)

		cog_path_local, cog_info = cog_cache[dataset_id]
		aoi_geometry = aoi_cache[dataset_id]

		# Export patch with masks as GeoTIFF
		result = export_patch_geotiff(token, cog_path_local, patch, output_dir, target_gsd, cog_info, aoi_geometry)

		if result:
			success_count += 1
		else:
			failed_count += 1

	# Cleanup temp COG files
	for cog_path_local, _ in cog_cache.values():
		if cog_path_local.exists():
			cog_path_local.unlink()

	# Print summary
	print('\n✅ Export complete!')
	print(f'   Successfully exported: {success_count} patches')
	if failed_count > 0:
		print(f'   Failed: {failed_count} patches')
	print(f'   Output directory: {output_dir.absolute()}')

	return 0 if failed_count == 0 else 1


if __name__ == '__main__':
	sys.exit(main())
