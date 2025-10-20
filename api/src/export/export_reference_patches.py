#!/usr/bin/env python3
"""
Export validated reference patches as GeoTIFF and PNG images.

This script exports patches from datasets marked in the reference_datasets table.
Patches can be filtered by validation status (deadwood_validated, forest_cover_validated).

Output structure: /data/reference_export/{uuid}/{dataset_id}/{geotiff,png,metadata}/
Accessible via: /reference/{uuid}/{dataset_id}/...

Features:
- Incremental exports (checks file existence)
- Automatic cleanup of removed datasets
- UUID-based access control

Output formats:
- GeoTIFF: RGB ortho + binary masks (deadwood/forest cover) in UTM projection
- PNG: RGB ortho visualization + binary mask PNGs

Usage:
	# Export all new/missing patches (production - uses UUID from env)
	python scripts/export_reference_patches.py

	# Export specific dataset
	python scripts/export_reference_patches.py --dataset-id 946

	# Export specific resolution
	python scripts/export_reference_patches.py --resolution 20

	# Custom output directory (dev/testing)
	python scripts/export_reference_patches.py --output-dir /tmp/test_export
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Optional
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
from shapely.ops import transform as shapely_transform
from pyproj import Transformer
from PIL import Image

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from shared.db import login, use_client
from shared.settings import settings

# Default credentials


def get_nginx_cog_url(cog_path: str, base_url: str = 'http://localhost:8080/cogs/v1') -> str:
	"""Construct nginx URL for COG file.

	Returns HTTP URL that rasterio can read directly (COGs support HTTP range requests).
	"""
	return f'{base_url}/{cog_path}'


def fetch_reference_datasets(token: str) -> list[int]:
	"""Fetch all dataset IDs from reference_datasets table."""
	try:
		with use_client(token) as client:
			response = client.from_('reference_datasets').select('dataset_id').execute()
			return [row['dataset_id'] for row in response.data] if response.data else []
	except Exception as e:
		print(f'❌ Error fetching reference datasets: {e}')
		return []


def fetch_validated_patches(
	token: str,
	dataset_id: Optional[int] = None,
	resolution_cm: Optional[int] = None,
	deadwood_only: bool = False,
	forest_cover_only: bool = False,
) -> list[dict]:
	"""Fetch validated patches from reference_patches table.

	By default, fetches patches where BOTH deadwood_validated AND forest_cover_validated are true.
	Use flags to filter for specific validation types.

	For 5cm/10cm patches without their own reference labels, adds parent 20cm patch's label IDs.
	"""
	try:
		with use_client(token) as client:
			query = client.from_('reference_patches').select('*')

			# Filter by dataset (either specific ID or reference_datasets list)
			if dataset_id:
				query = query.eq('dataset_id', dataset_id)
			else:
				# Only fetch from reference datasets
				ref_dataset_ids = fetch_reference_datasets(token)
				if not ref_dataset_ids:
					print('⚠️  No reference datasets found in reference_datasets table')
					return []
				query = query.in_('dataset_id', ref_dataset_ids)

			# Filter by resolution
			if resolution_cm:
				query = query.eq('resolution_cm', resolution_cm)

			# Filter by validation status
			if deadwood_only:
				query = query.eq('deadwood_validated', True)
			elif forest_cover_only:
				query = query.eq('forest_cover_validated', True)
			else:
				# Default: Both validated
				query = query.eq('deadwood_validated', True).eq('forest_cover_validated', True)

			response = query.order('dataset_id').order('resolution_cm').order('patch_index').execute()
			patches = response.data if response.data else []

			# For 5cm/10cm patches without their own labels, look up parent 20cm patch labels
			# Group by dataset to minimize queries
			patches_needing_parent = []
			for patch in patches:
				if patch['resolution_cm'] in [5, 10]:
					if not patch.get('reference_deadwood_label_id') and not patch.get(
						'reference_forest_cover_label_id'
					):
						patches_needing_parent.append(patch)

			if patches_needing_parent:
				# Group by dataset_id to fetch parent patches efficiently
				dataset_ids = list(set(p['dataset_id'] for p in patches_needing_parent))
				parent_label_cache = {}

				for ds_id in dataset_ids:
					# Fetch 20cm patch for this dataset
					parent_response = (
						client.from_('reference_patches')
						.select('patch_index, reference_deadwood_label_id, reference_forest_cover_label_id')
						.eq('dataset_id', ds_id)
						.eq('resolution_cm', 20)
						.execute()
					)

					if parent_response.data:
						for parent in parent_response.data:
							parent_patch_index = parent['patch_index']
							parent_label_cache[f'{ds_id}_{parent_patch_index}'] = {
								'deadwood': parent.get('reference_deadwood_label_id'),
								'forestcover': parent.get('reference_forest_cover_label_id'),
							}

				# Add parent label IDs to child patches
				for patch in patches:
					if patch['resolution_cm'] in [5, 10]:
						if not patch.get('reference_deadwood_label_id') and not patch.get(
							'reference_forest_cover_label_id'
						):
							# Extract parent patch index from child (e.g., "20_1760952965035_0_1" -> "20_1760952965035")
							patch_index_parts = patch['patch_index'].split('_')
							if len(patch_index_parts) >= 2:
								parent_patch_index = '_'.join(patch_index_parts[:2])
								cache_key = f'{patch["dataset_id"]}_{parent_patch_index}'

								if cache_key in parent_label_cache:
									parent_labels = parent_label_cache[cache_key]
									patch['parent_deadwood_label_id'] = parent_labels['deadwood']
									patch['parent_forestcover_label_id'] = parent_labels['forestcover']

			return patches
	except Exception as e:
		print(f'❌ Error fetching patches: {e}')
		return []


def fetch_cog_info(token: str, dataset_id: int) -> Optional[dict]:
	"""Fetch COG info for a dataset."""
	with use_client(token) as client:
		response = (
			client.from_(settings.cogs_table)
			.select('cog_path, cog_info')
			.eq('dataset_id', dataset_id)
			.single()
			.execute()
		)
		return response.data if response.data else None


def fetch_aoi_geometry(token: str, dataset_id: int) -> Optional[dict]:
	"""Fetch AOI geometry for a dataset."""
	try:
		with use_client(token) as client:
			response = client.from_('v2_aois').select('geometry').eq('dataset_id', dataset_id).execute()
			if response.data and len(response.data) > 0:
				return response.data[0]['geometry']
			return None
	except Exception as e:
		print(f'⚠️  Error fetching AOI: {e}')
		return None


def fetch_model_prediction_label_ids(token: str, dataset_id: int) -> dict:
	"""Fetch ML model prediction label IDs for a dataset.

	Returns:
		Dict with 'deadwood' and 'forest_cover' label IDs (can be None)
	"""
	label_ids = {'deadwood': None, 'forest_cover': None}
	try:
		with use_client(token) as client:
			# Fetch model prediction labels
			response = (
				client.from_('v2_labels')
				.select('id, label_data')
				.eq('dataset_id', dataset_id)
				.eq('label_source', 'model_prediction')
				.execute()
			)

			if response.data:
				for label in response.data:
					if label['label_data'] == 'deadwood':
						label_ids['deadwood'] = label['id']
					elif label['label_data'] == 'forest_cover':
						label_ids['forest_cover'] = label['id']

			return label_ids
	except Exception as e:
		print(f'⚠️  Error fetching model prediction labels: {e}')
		return label_ids


def fetch_geometries_by_label(token: str, label_id: int, table_name: str, bbox: tuple, epsg_code: int) -> list:
	"""Fetch reference geometries for a label that intersect with bbox."""
	try:
		minx, miny, maxx, maxy = bbox

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
					geom_4326 = shape(row['geometry'])
					geom_utm = shapely_transform(transformer.transform, geom_4326)
					if geom_utm.intersects(tile_box):
						geometries.append(geom_utm)
				except Exception:
					continue

			return geometries

	except Exception as e:
		print(f'❌ Error fetching geometries by label: {e}')
		return []


def patch_files_exist(output_dir: Path, filename_base: str, has_ref: bool) -> bool:
	"""Check if all required files for a patch already exist.

	Args:
		output_dir: Base output directory for the dataset
		filename_base: Base filename (e.g., "420_0_0_5cm")
		has_ref: Whether reference masks should exist

	Returns:
		True if all required files exist, False otherwise
	"""
	# Check RGB files (always required)
	geotiff_path = output_dir / 'geotiff' / f'{filename_base}.tif'
	png_path = output_dir / 'png' / f'{filename_base}.png'
	json_path = output_dir / 'metadata' / f'{filename_base}.json'

	if not (geotiff_path.exists() and png_path.exists() and json_path.exists()):
		return False

	# Check reference masks if they should exist
	if has_ref:
		ref_files = [
			output_dir / 'geotiff' / f'{filename_base}_deadwood_ref.tif',
			output_dir / 'geotiff' / f'{filename_base}_forestcover_ref.tif',
			output_dir / 'png' / f'{filename_base}_deadwood_ref.png',
			output_dir / 'png' / f'{filename_base}_forestcover_ref.png',
		]
		if not all(f.exists() for f in ref_files):
			return False

	return True


def cleanup_removed_datasets(output_base_dir: Path, reference_dataset_ids: list[int]):
	"""Remove dataset directories that are no longer in reference_datasets.

	Args:
		output_base_dir: Base output directory (e.g., /data/reference_export/{uuid}/)
		reference_dataset_ids: List of dataset IDs currently in reference_datasets
	"""
	if not output_base_dir.exists():
		return

	removed_count = 0
	for dataset_dir in output_base_dir.iterdir():
		if not dataset_dir.is_dir():
			continue

		try:
			dataset_id = int(dataset_dir.name)
			if dataset_id not in reference_dataset_ids:
				print(f'🗑️  Removing dataset {dataset_id} (no longer in reference_datasets)')
				import shutil

				shutil.rmtree(dataset_dir)
				removed_count += 1
		except (ValueError, OSError):
			# Skip non-numeric directories or errors
			continue

	if removed_count > 0:
		print(f'✓ Cleaned up {removed_count} removed dataset(s)\n')


def rasterize_geometries(geometries: list, bbox: tuple, width: int = 1024, height: int = 1024) -> np.ndarray:
	"""Rasterize geometries to a binary mask."""
	if not geometries:
		return np.zeros((height, width), dtype=np.uint8)

	minx, miny, maxx, maxy = bbox
	transform = transform_from_bounds(minx, miny, maxx, maxy, width, height)

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
	"""Create binary mask from AOI geometry."""
	if not aoi_geojson:
		return np.ones((height, width), dtype=np.uint8)

	try:
		aoi_shape = shape(aoi_geojson)
		transformer = Transformer.from_crs('EPSG:4326', f'EPSG:{epsg_code}', always_xy=True)
		aoi_shape_utm = shapely_transform(transformer.transform, aoi_shape)

		minx, miny, maxx, maxy = bbox
		raster_transform = transform_from_bounds(minx, miny, maxx, maxy, width, height)

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
		return np.ones((height, width), dtype=np.uint8)


def export_patch(
	token: str,
	cog_url: str,
	patch: dict,
	output_dir: Path,
	target_gsd_m: float,
	cog_info: dict,
	aoi_geometry: Optional[dict],
	export_geotiff: bool = True,
	export_png: bool = True,
) -> Optional[Path]:
	"""Export a single patch as GeoTIFF and/or PNG."""
	dataset_id = patch['dataset_id']
	patch_index = patch['patch_index']
	patch_id = patch['id']
	resolution_cm = patch['resolution_cm']
	epsg_code = patch['epsg_code']
	utm_zone = patch.get('utm_zone')

	if not epsg_code:
		print(f'❌ Patch {patch_index}: Missing epsg_code field')
		return None

	# Extract bounding box in UTM coordinates
	minx_utm = patch['bbox_minx']
	miny_utm = patch['bbox_miny']
	maxx_utm = patch['bbox_maxx']
	maxy_utm = patch['bbox_maxy']

	bbox_tuple_utm = (minx_utm, miny_utm, maxx_utm, maxy_utm)

	try:
		# Open COG directly via HTTP (COGs support efficient range requests)
		with rasterio.open(cog_url) as src:
			with WarpedVRT(
				src,
				crs=f'EPSG:{epsg_code}',
				resampling=Resampling.bilinear,
			) as vrt:
				# Create window from UTM bounds
				window = from_bounds(minx_utm, miny_utm, maxx_utm, maxy_utm, vrt.transform)

				# Read RGB bands with resampling to exact 1024x1024
				data = vrt.read(
					indexes=[1, 2, 3], window=window, out_shape=(3, 1024, 1024), resampling=Resampling.bilinear
				)

		if data.shape != (3, 1024, 1024):
			print(f'❌ Patch {patch_index}: Invalid data shape {data.shape}')
			return None

		# Create AOI mask
		aoi_mask = create_aoi_mask(aoi_geometry, bbox_tuple_utm, epsg_code)

		# Apply AOI mask to RGB
		aoi_mask_3d = np.expand_dims(aoi_mask, axis=2)
		aoi_mask_broadcast = np.broadcast_to(aoi_mask_3d, (1024, 1024, 3))
		img_data_masked = np.moveaxis(data, 0, -1) * aoi_mask_broadcast
		rgb_data = np.moveaxis(img_data_masked, -1, 0).astype(np.uint8)

		# Fetch reference label geometries
		# For 5cm/10cm patches, use parent 20cm patch's labels if they don't have their own
		# Always create masks - empty mask (all zeros) if no geometries found
		deadwood_ref_mask = None
		has_deadwood_ref_label = False
		deadwood_ref_label_id = patch.get('reference_deadwood_label_id') or patch.get('parent_deadwood_label_id')
		if deadwood_ref_label_id:
			has_deadwood_ref_label = True
			deadwood_ref_geoms = fetch_geometries_by_label(
				token, deadwood_ref_label_id, 'reference_patch_deadwood_geometries', bbox_tuple_utm, epsg_code
			)
			# Rasterize at patch's resolution and crop to patch extent
			# This automatically handles different resolutions (5cm, 10cm, 20cm)
			deadwood_ref_mask = rasterize_geometries(deadwood_ref_geoms, bbox_tuple_utm)
			deadwood_ref_mask = ((deadwood_ref_mask > 0) * aoi_mask).astype(np.uint8)

		forestcover_ref_mask = None
		has_forestcover_ref_label = False
		forestcover_ref_label_id = patch.get('reference_forest_cover_label_id') or patch.get(
			'parent_forestcover_label_id'
		)
		if forestcover_ref_label_id:
			has_forestcover_ref_label = True
			forestcover_ref_geoms = fetch_geometries_by_label(
				token, forestcover_ref_label_id, 'reference_patch_forest_cover_geometries', bbox_tuple_utm, epsg_code
			)
			# Rasterize at patch's resolution and crop to patch extent
			# This automatically handles different resolutions (5cm, 10cm, 20cm)
			forestcover_ref_mask = rasterize_geometries(forestcover_ref_geoms, bbox_tuple_utm)
			forestcover_ref_mask = ((forestcover_ref_mask > 0) * aoi_mask).astype(np.uint8)

		# Note: We only export reference (human-validated) masks, not ML predictions

		# Create output filenames with simplified naming
		# Extract grid coordinates from patch_index if available (e.g., "20_1760951000108_0_0" -> "0_0")
		# Otherwise use the full patch_index
		tile_id = patch_index.split('_')[-2:] if '_' in patch_index else [patch_index]
		tile_id = '_'.join(tile_id) if len(tile_id) > 1 else tile_id[0]
		filename_base = f'{dataset_id}_{tile_id}_{resolution_cm}cm'

		# Export GeoTIFF
		if export_geotiff:
			geotiff_path = output_dir / 'geotiff' / f'{filename_base}.tif'
			geotiff_path.parent.mkdir(parents=True, exist_ok=True)

			utm_transform = transform_from_bounds(minx_utm, miny_utm, maxx_utm, maxy_utm, 1024, 1024)

			# Save RGB GeoTIFF
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

			# Save deadwood reference mask GeoTIFF (always export if label exists, even if empty)
			if has_deadwood_ref_label:
				deadwood_ref_geotiff_path = output_dir / 'geotiff' / f'{filename_base}_deadwood_ref.tif'
				with rasterio.open(
					deadwood_ref_geotiff_path,
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
					dst.write(deadwood_ref_mask, 1)

			# Save forest cover reference mask GeoTIFF (always export if label exists, even if empty)
			if has_forestcover_ref_label:
				forestcover_ref_geotiff_path = output_dir / 'geotiff' / f'{filename_base}_forestcover_ref.tif'
				with rasterio.open(
					forestcover_ref_geotiff_path,
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
					dst.write(forestcover_ref_mask, 1)

		# Export PNG
		if export_png:
			png_path = output_dir / 'png' / f'{filename_base}.png'
			png_path.parent.mkdir(parents=True, exist_ok=True)

			# Convert CHW to HWC for PIL
			rgb_hwc = np.moveaxis(rgb_data, 0, -1)
			img = Image.fromarray(rgb_hwc)
			img.save(png_path, optimize=True)

			# Save deadwood reference mask PNG (always export if label exists, even if empty)
			if has_deadwood_ref_label:
				deadwood_ref_png_path = output_dir / 'png' / f'{filename_base}_deadwood_ref.png'
				deadwood_ref_vis = (deadwood_ref_mask * 255).astype(np.uint8)
				img_deadwood_ref = Image.fromarray(deadwood_ref_vis)
				img_deadwood_ref.save(deadwood_ref_png_path, optimize=True)

			# Save forest cover reference mask PNG (always export if label exists, even if empty)
			if has_forestcover_ref_label:
				forestcover_ref_png_path = output_dir / 'png' / f'{filename_base}_forestcover_ref.png'
				forestcover_ref_vis = (forestcover_ref_mask * 255).astype(np.uint8)
				img_forestcover_ref = Image.fromarray(forestcover_ref_vis)
				img_forestcover_ref.save(forestcover_ref_png_path, optimize=True)

		# Save metadata JSON
		center_x_utm = (minx_utm + maxx_utm) / 2.0
		center_y_utm = (miny_utm + maxy_utm) / 2.0
		transformer_to_wgs84 = Transformer.from_crs(f'EPSG:{epsg_code}', 'EPSG:4326', always_xy=True)
		center_lon, center_lat = transformer_to_wgs84.transform(center_x_utm, center_y_utm)

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
			},
			'center_wgs84': {'lon': center_lon, 'lat': center_lat},
			'target_gsd_m': target_gsd_m,
			'image_size_px': {'width': 1024, 'height': 1024},
			'masks': {
				'deadwood_reference': has_deadwood_ref_label,
				'forestcover_reference': has_forestcover_ref_label,
			},
			'validation': {
				'deadwood_validated': patch.get('deadwood_validated'),
				'forest_cover_validated': patch.get('forest_cover_validated'),
			},
		}

		json_path = output_dir / 'metadata' / f'{filename_base}.json'
		json_path.parent.mkdir(parents=True, exist_ok=True)
		with open(json_path, 'w') as f:
			json.dump(metadata, f, indent=2)

		return png_path if export_png else geotiff_path if export_geotiff else None

	except Exception as e:
		print(f'❌ Error exporting patch {patch_index}: {e}')
		import traceback

		traceback.print_exc()
		return None


def main():
	parser = argparse.ArgumentParser(
		description='Export validated reference patches as GeoTIFF and PNG with incremental updates',
		formatter_class=argparse.RawDescriptionHelpFormatter,
	)

	parser.add_argument(
		'--output-dir', type=str, help='Custom output directory (for testing, default: /data/reference_export/{UUID})'
	)
	parser.add_argument('--dataset-id', type=int, help='Export patches only for this dataset ID')
	parser.add_argument('--resolution', type=int, choices=[5, 10, 20], help='Export patches only for this resolution')
	parser.add_argument(
		'--nginx-url',
		type=str,
		help='Base URL for nginx COG endpoint (default: env NGINX_COG_URL or http://localhost:8080/cogs/v1)',
	)
	parser.add_argument('--user', type=str, help='Database user email')
	parser.add_argument('--password', type=str, help='Database user password')
	parser.add_argument('--force', action='store_true', help='Force re-export even if files exist')

	args = parser.parse_args()

	# Get credentials
	user_email = args.user or os.getenv('DEADTREES_USER')
	user_password = args.password or os.getenv('DEADTREES_PASSWORD')

	# Get nginx COG URL (from args, env, or default)
	if not args.nginx_url:
		args.nginx_url = os.getenv('NGINX_COG_URL', 'http://localhost:8080/cogs/v1')

	# Authenticate
	print('🔐 Authenticating...')
	print(f'   User: {user_email}')
	try:
		token = login(user_email, user_password)
		print('✓ Authenticated successfully\n')
	except Exception as e:
		print(f'❌ Authentication failed: {e}')
		return 1

	# Determine output directory structure
	if args.output_dir:
		# Custom directory for testing
		output_base_dir = Path(args.output_dir)
		print(f'📁 Using custom output directory: {output_base_dir.absolute()}')
	else:
		# Production: Use UUID-based structure
		export_uuid = os.getenv('REFERENCE_EXPORT_UUID')
		if not export_uuid:
			print('❌ REFERENCE_EXPORT_UUID environment variable not set!')
			print('   Set it in .env.export or pass --output-dir for testing')
			return 1

		# Check for custom base data directory (for dev/test environments)
		base_data_dir = os.getenv('BASE_DATA_DIR', '/data')
		output_base_dir = Path(base_data_dir) / 'reference_export' / export_uuid
		print(f'📁 Production export directory: {output_base_dir.absolute()}')
		print(f'   Accessible at: /reference/{export_uuid}/<dataset_id>/...\n')

	output_base_dir.mkdir(parents=True, exist_ok=True)

	# Fetch reference datasets for cleanup
	print('🔍 Fetching reference datasets...')
	reference_dataset_ids = fetch_reference_datasets(token)
	if not reference_dataset_ids:
		print('⚠️  No reference datasets found')
		return 0

	print(f'✓ Found {len(reference_dataset_ids)} reference dataset(s)\n')

	# Cleanup datasets that are no longer in reference_datasets
	print('🗑️  Checking for removed datasets...')
	cleanup_removed_datasets(output_base_dir, reference_dataset_ids)

	# Fetch patches
	print('🔍 Fetching validated patches from database...')
	patches = fetch_validated_patches(
		token,
		dataset_id=args.dataset_id,
		resolution_cm=args.resolution,
		deadwood_only=False,
		forest_cover_only=False,
	)

	if not patches:
		print('✓ No new patches to export')
		return 0

	print(f'✓ Found {len(patches)} validated patches in database\n')

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

	print('📊 Patches by dataset:')
	for dataset_id in sorted(by_dataset.keys()):
		resolutions = by_dataset[dataset_id]
		res_str = ', '.join([f'{count}x{res}cm' for res, count in sorted(resolutions.items())])
		print(f'  Dataset {dataset_id}: {res_str}')
	print()

	# Export patches
	print('🚀 Exporting patches...')

	# Track COG URLs, AOI geometries we've already fetched per dataset
	cog_cache: dict[int, tuple[str, dict]] = {}  # dataset_id -> (cog_url, cog_info)
	aoi_cache: dict[int, Optional[dict]] = {}

	success_count = 0
	failed_count = 0
	skipped_count = 0

	for patch in tqdm(patches, desc='Exporting patches'):
		dataset_id = patch['dataset_id']
		resolution_cm = patch['resolution_cm']
		patch_index = patch['patch_index']

		# GSD mapping
		gsd_map = {20: 0.20, 10: 0.10, 5: 0.05}
		target_gsd = gsd_map[resolution_cm]

		# Dataset-specific output directory structure
		dataset_output_dir = output_base_dir / str(dataset_id)

		# Generate filename for existence check
		tile_id = patch_index.split('_')[-2:] if '_' in patch_index else [patch_index]
		tile_id = '_'.join(tile_id) if len(tile_id) > 1 else tile_id[0]
		filename_base = f'{dataset_id}_{tile_id}_{resolution_cm}cm'

		# Check if patch has reference labels (including parent labels for 5cm/10cm patches)
		has_ref = (
			patch.get('reference_deadwood_label_id')
			or patch.get('parent_deadwood_label_id')
			or patch.get('reference_forest_cover_label_id')
			or patch.get('parent_forestcover_label_id')
		)

		# Check if files already exist (incremental export)
		if not args.force and patch_files_exist(dataset_output_dir, filename_base, has_ref):
			skipped_count += 1
			continue

		# Get COG URL (fetch from DB if not cached)
		if dataset_id not in cog_cache:
			cog_data = fetch_cog_info(token, dataset_id)
			if not cog_data:
				print(f'\n❌ No COG found for dataset {dataset_id}')
				failed_count += 1
				continue

			# Build COG URL (rasterio can read directly via HTTP)
			cog_url = get_nginx_cog_url(cog_data['cog_path'], args.nginx_url)
			cog_cache[dataset_id] = (cog_url, cog_data['cog_info'])

		# Get AOI geometry (fetch from DB if not cached)
		if dataset_id not in aoi_cache:
			aoi_cache[dataset_id] = fetch_aoi_geometry(token, dataset_id)

		cog_url, cog_info = cog_cache[dataset_id]
		aoi_geometry = aoi_cache[dataset_id]

		# Export patch (always export both geotiff and png)
		result = export_patch(
			token,
			cog_url,
			patch,
			dataset_output_dir,
			target_gsd,
			cog_info,
			aoi_geometry,
			export_geotiff=True,
			export_png=True,
		)

		if result:
			success_count += 1
		else:
			failed_count += 1

	# Print summary
	print('\n✅ Export complete!')
	print(f'   Newly exported: {success_count} patches')
	print(f'   Skipped (already exist): {skipped_count} patches')
	if failed_count > 0:
		print(f'   Failed: {failed_count} patches')
	print('\n📁 Output structure:')
	print(f'   {output_base_dir.absolute()}/<dataset_id>/geotiff/')
	print(f'   {output_base_dir.absolute()}/<dataset_id>/png/')
	print(f'   {output_base_dir.absolute()}/<dataset_id>/metadata/')

	return 0 if failed_count == 0 else 1


if __name__ == '__main__':
	sys.exit(main())
