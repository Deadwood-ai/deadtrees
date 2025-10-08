#!/usr/bin/env python3
"""
Export ML training tiles as 1024x1024 PNG images with JSON metadata.

This script:
1. Queries the database for tiles with status='good'
2. Downloads COGs via nginx
3. Crops and resamples to exact tile boundaries (1024x1024 pixels)
4. Validates effective GSD matches target GSD
5. Exports PNG + JSON sidecar files

Usage:
	python scripts/export_ml_tiles.py --output-dir ml_ready_tiles
	python scripts/export_ml_tiles.py --output-dir /path/to/export --dataset-id 426
	python scripts/export_ml_tiles.py --output-dir ml_ready_tiles --resolution 5
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
from PIL import Image
from tqdm import tqdm
from shapely.geometry import shape, box
from shapely import wkb
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


def export_tile_png(
	token: str,
	cog_path_local: Path,
	tile: dict,
	output_dir: Path,
	target_gsd_m: float,
	cog_info: dict,
	aoi_geometry: Optional[dict],
	label_ids: dict,
) -> Optional[Path]:
	"""Export a single tile as 1024x1024 PNG with JSON metadata and prediction masks.

	Args:
		token: Authentication token
		cog_path_local: Path to local COG file
		tile: Tile record from database
		output_dir: Output directory for PNG files
		target_gsd_m: Target ground sample distance in meters
		cog_info: COG info from database
		aoi_geometry: AOI GeoJSON geometry
		label_ids: Dictionary with 'deadwood' and 'forest_cover' label IDs

	Returns:
		Path to exported PNG file, or None if export failed
	"""
	dataset_id = tile['dataset_id']
	tile_index = tile['tile_index']
	resolution_cm = tile['resolution_cm']

	# Extract bounding box
	minx = tile['bbox_minx']
	miny = tile['bbox_miny']
	maxx = tile['bbox_maxx']
	maxy = tile['bbox_maxy']

	# Calculate effective GSD from bbox
	bbox_width_m = maxx - minx
	bbox_height_m = maxy - miny
	eff_gsd_x = bbox_width_m / 1024.0
	eff_gsd_y = bbox_height_m / 1024.0

	# Validate GSD matches target (within 1mm tolerance)
	if abs(eff_gsd_x - target_gsd_m) > 0.001 or abs(eff_gsd_y - target_gsd_m) > 0.001:
		print(f'❌ Tile {tile_index}: GSD mismatch! Expected {target_gsd_m}m, got {eff_gsd_x:.6f}m x {eff_gsd_y:.6f}m')
		return None

	# Validate tile is within COG bounds
	cog_bbox = cog_info['GEO']['BoundingBox']
	cog_bounds = (cog_bbox[0], cog_bbox[1], cog_bbox[2], cog_bbox[3])  # left, bottom, right, top

	if not validate_tile_bounds((minx, miny, maxx, maxy), cog_bounds, dataset_id, tile_index):
		return None

	try:
		with rasterio.open(cog_path_local) as src:
			# Create window from bounds
			# Note: from_bounds expects (left, bottom, right, top) but in image coordinates
			# In EPSG:3857, Y increases northward, so maxy is top, miny is bottom
			window = from_bounds(minx, miny, maxx, maxy, src.transform)

			# Read RGB bands with resampling to exact 1024x1024
			data = src.read(indexes=[1, 2, 3], window=window, out_shape=(3, 1024, 1024), resampling=Resampling.bilinear)

			# Check data shape
			if data.shape != (3, 1024, 1024):
				print(f'❌ Tile {tile_index}: Invalid data shape {data.shape}, expected (3, 1024, 1024)')
				return None

			# Convert to HWC format for PIL
			img_data = np.moveaxis(data, 0, -1)

			# Create AOI mask
			bbox_tuple = (minx, miny, maxx, maxy)
			aoi_mask = create_aoi_mask(aoi_geometry, bbox_tuple)

			# Apply AOI mask to RGB image (set to black outside AOI)
			aoi_mask_3d = np.expand_dims(aoi_mask, axis=2)
			img_data_masked = img_data * aoi_mask_3d

			# Fetch and rasterize deadwood predictions
			deadwood_mask = None
			if 'deadwood' in label_ids:
				deadwood_geoms = fetch_prediction_geometries(
					token, label_ids['deadwood'], 'v2_deadwood_geometries', bbox_tuple
				)
				deadwood_mask = rasterize_geometries(deadwood_geoms, bbox_tuple)
				# Apply AOI mask to deadwood predictions
				deadwood_mask = deadwood_mask * aoi_mask

			# Fetch and rasterize forest cover predictions
			forestcover_mask = None
			if 'forest_cover' in label_ids:
				forestcover_geoms = fetch_prediction_geometries(
					token, label_ids['forest_cover'], 'v2_forest_cover_geometries', bbox_tuple
				)
				forestcover_mask = rasterize_geometries(forestcover_geoms, bbox_tuple)
				# Apply AOI mask to forest cover predictions
				forestcover_mask = forestcover_mask * aoi_mask

			# Create output filenames
			filename_base = f'{dataset_id}_{tile_index}_{resolution_cm}cm'
			png_path = output_dir / f'{filename_base}.png'
			json_path = output_dir / f'{filename_base}.json'
			deadwood_path = output_dir / f'{filename_base}_deadwood.png'
			forestcover_path = output_dir / f'{filename_base}_forestcover.png'

			# Save RGB PNG (cropped by AOI)
			img = Image.fromarray(img_data_masked.astype(np.uint8))
			img.save(png_path, 'PNG')

			# Save deadwood mask if available
			has_deadwood = False
			if deadwood_mask is not None:
				Image.fromarray(deadwood_mask).save(deadwood_path, 'PNG')
				has_deadwood = True

			# Save forest cover mask if available
			has_forestcover = False
			if forestcover_mask is not None:
				Image.fromarray(forestcover_mask).save(forestcover_path, 'PNG')
				has_forestcover = True

			# Create metadata JSON
			metadata = {
				'dataset_id': dataset_id,
				'tile_id': tile['id'],
				'tile_index': tile_index,
				'resolution_cm': resolution_cm,
				'bbox_epsg3857': {'minx': minx, 'miny': miny, 'maxx': maxx, 'maxy': maxy},
				'effective_gsd_m': {'x': eff_gsd_x, 'y': eff_gsd_y},
				'target_gsd_m': target_gsd_m,
				'image_size_px': {'width': 1024, 'height': 1024},
				'source_cog_resolution_m_px': cog_info['GEO']['Resolution'][0],
				'has_deadwood_mask': has_deadwood,
				'has_forestcover_mask': has_forestcover,
				'aoi_cropped': aoi_geometry is not None,
				'coverage_stats': {
					'aoi_coverage_percent': tile.get('aoi_coverage_percent'),
					'deadwood_prediction_coverage_percent': tile.get('deadwood_prediction_coverage_percent'),
					'forest_cover_prediction_coverage_percent': tile.get('forest_cover_prediction_coverage_percent'),
				},
				'created_at': tile['created_at']
				if isinstance(tile['created_at'], str)
				else tile['created_at'].isoformat(),
				'user_id': str(tile['user_id']),
			}

			# Save JSON
			with open(json_path, 'w') as f:
				json.dump(metadata, f, indent=2)

			return png_path

	except Exception as e:
		print(f'❌ Error exporting tile {tile_index}: {e}')
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


def fetch_label_ids(token: str, dataset_id: int) -> dict:
	"""Fetch label IDs for model predictions (deadwood and forest cover).

	Args:
		token: Authentication token
		dataset_id: Dataset ID

	Returns:
		Dictionary with 'deadwood' and 'forest_cover' label IDs
	"""
	try:
		with use_client(token) as client:
			response = (
				client.from_('v2_labels')
				.select('id, label_data')
				.eq('dataset_id', dataset_id)
				.eq('label_source', 'model_prediction')
				.execute()
			)

			labels = {}
			if response.data:
				for label in response.data:
					labels[label['label_data']] = label['id']

			return labels
	except Exception as e:
		print(f'❌ Error fetching label IDs: {e}')
		return {}


def fetch_prediction_geometries(token: str, label_id: int, table_name: str, bbox: tuple) -> list:
	"""Fetch prediction geometries that intersect with tile bounds.

	Args:
		token: Authentication token
		label_id: Label ID
		table_name: 'v2_deadwood_geometries' or 'v2_forest_cover_geometries'
		bbox: Tile bounding box (minx, miny, maxx, maxy) in EPSG:3857

	Returns:
		List of WKB geometries
	"""
	try:
		minx, miny, maxx, maxy = bbox

		# Fetch all geometries for this label
		with use_client(token) as client:
			response = client.from_(table_name).select('geometry').eq('label_id', label_id).execute()

			if not response.data:
				return []

			# Create transformer for EPSG:4326 -> EPSG:3857
			transformer = Transformer.from_crs('EPSG:4326', 'EPSG:3857', always_xy=True)

			# Convert WKB to shapely geometries, reproject, and filter by bbox
			tile_box = box(minx, miny, maxx, maxy)
			geometries = []

			for row in response.data:
				try:
					# Load geometry from GeoJSON (in EPSG:4326)
					geom_4326 = shape(row['geometry'])

					# Reproject to EPSG:3857
					geom_3857 = transform(transformer.transform, geom_4326)

					# Check if it intersects with tile
					if geom_3857.intersects(tile_box):
						geometries.append(geom_3857)
				except Exception as e:
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


def create_aoi_mask(aoi_geojson: dict, bbox: tuple, width: int = 1024, height: int = 1024) -> np.ndarray:
	"""Create binary mask from AOI geometry.

	Args:
		aoi_geojson: AOI GeoJSON geometry (in EPSG:4326/WGS84)
		bbox: Tile bounding box (minx, miny, maxx, maxy) in EPSG:3857
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

		# Reproject AOI from EPSG:4326 (WGS84) to EPSG:3857 (Web Mercator)
		transformer = Transformer.from_crs('EPSG:4326', 'EPSG:3857', always_xy=True)
		aoi_shape_3857 = transform(transformer.transform, aoi_shape)

		minx, miny, maxx, maxy = bbox
		raster_transform = transform_from_bounds(minx, miny, maxx, maxy, width, height)

		# Rasterize AOI with value 1 for inside
		aoi_mask = rasterize(
			[(aoi_shape_3857, 1)],
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


def fetch_good_tiles(token: str, dataset_id: Optional[int] = None, resolution_cm: Optional[int] = None) -> list[dict]:
	"""Fetch all tiles with status='good' from database.

	Args:
		token: Authentication token
		dataset_id: Optional dataset ID filter
		resolution_cm: Optional resolution filter (5, 10, or 20)

	Returns:
		List of tile records
	"""
	try:
		with use_client(token) as client:
			query = client.from_('ml_training_tiles').select('*').eq('status', 'good')

			if dataset_id:
				query = query.eq('dataset_id', dataset_id)

			if resolution_cm:
				query = query.eq('resolution_cm', resolution_cm)

			response = query.order('dataset_id').order('resolution_cm').order('tile_index').execute()

			return response.data if response.data else []
	except Exception as e:
		print(f'❌ Error fetching tiles: {e}')
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
		description='Export ML training tiles as 1024x1024 PNG images',
		formatter_class=argparse.RawDescriptionHelpFormatter,
		epilog="""
Examples:
  # Export all good tiles (uses default credentials)
  python scripts/export_ml_tiles.py --output-dir ml_ready_tiles
  
  # Export with custom credentials via CLI
  python scripts/export_ml_tiles.py --output-dir ml_ready_tiles --user myuser@example.com --password mypassword
  
  # Export with credentials from environment variables
  export DEADTREES_USER=myuser@example.com
  export DEADTREES_PASSWORD=mypassword
  python scripts/export_ml_tiles.py --output-dir ml_ready_tiles
  
  # Export only dataset 426
  python scripts/export_ml_tiles.py --output-dir ml_ready_tiles --dataset-id 426
  
  # Export only 5cm resolution tiles
  python scripts/export_ml_tiles.py --output-dir ml_ready_tiles --resolution 5
  
  # Custom nginx endpoint
  python scripts/export_ml_tiles.py --output-dir ml_ready_tiles --nginx-url http://production:8080/cogs/v1
  
  # Dry run to preview what would be exported
  python scripts/export_ml_tiles.py --output-dir ml_ready_tiles --dry-run

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
		help='Output directory for exported tiles (default: ml_ready_tiles)',
	)
	parser.add_argument('--dataset-id', type=int, help='Export tiles only for this dataset ID')
	parser.add_argument(
		'--resolution', type=int, choices=[5, 10, 20], help='Export tiles only for this resolution (5, 10, or 20 cm)'
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

	# Fetch tiles
	print('🔍 Fetching tiles from database...')
	tiles = fetch_good_tiles(token, dataset_id=args.dataset_id, resolution_cm=args.resolution)

	if not tiles:
		print('❌ No good tiles found matching criteria')
		return 1

	print(f'✓ Found {len(tiles)} good tiles to export\n')

	# Group tiles by dataset and resolution for summary
	by_dataset = {}
	for tile in tiles:
		dataset_id = tile['dataset_id']
		resolution = tile['resolution_cm']

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

	# Export tiles
	print('🚀 Exporting tiles...')

	# Track COGs, AOI, and labels we've already fetched per dataset
	cog_cache: dict[int, tuple[Path, dict]] = {}
	aoi_cache: dict[int, Optional[dict]] = {}
	label_cache: dict[int, dict] = {}

	success_count = 0
	failed_count = 0

	for tile in tqdm(tiles, desc='Exporting tiles'):
		dataset_id = tile['dataset_id']
		resolution_cm = tile['resolution_cm']

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

		# Get label IDs (fetch from DB if not cached)
		if dataset_id not in label_cache:
			label_cache[dataset_id] = fetch_label_ids(token, dataset_id)

		cog_path_local, cog_info = cog_cache[dataset_id]
		aoi_geometry = aoi_cache[dataset_id]
		label_ids = label_cache[dataset_id]

		# Export tile with masks
		result = export_tile_png(token, cog_path_local, tile, output_dir, target_gsd, cog_info, aoi_geometry, label_ids)

		if result:
			success_count += 1
		else:
			failed_count += 1

	# Cleanup temp COG files
	for cog_path_local, _ in cog_cache.values():
		if cog_path_local.exists():
			cog_path_local.unlink()

	# Print summary
	print(f'\n✅ Export complete!')
	print(f'   Successfully exported: {success_count} tiles')
	if failed_count > 0:
		print(f'   Failed: {failed_count} tiles')
	print(f'   Output directory: {output_dir.absolute()}')

	return 0 if failed_count == 0 else 1


if __name__ == '__main__':
	sys.exit(main())
