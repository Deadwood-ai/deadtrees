#!/usr/bin/env python3
"""
Export validated reference patches as GeoTIFF and PNG images.

This script exports patches from datasets marked in the reference_datasets table.
Patches can be filtered by validation status (deadwood_validated, forest_cover_validated).

Output structure: /data/reference_export/{uuid}/{dataset_id}/{geotiff,png,metadata}/
Accessible via: /reference/{uuid}/{dataset_id}/...

Features:
- Incremental exports (timestamp-based change detection)
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
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
import os

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import from_bounds
from rasterio.features import rasterize
from rasterio.transform import from_bounds as transform_from_bounds
from rasterio.vrt import WarpedVRT
from tqdm import tqdm
from shapely.geometry import MultiPolygon, shape, box
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


def parse_optional_datetime(value) -> Optional[datetime]:
	"""Parse string/datetime values to timezone-aware datetime."""
	if value is None:
		return None

	if isinstance(value, datetime):
		if value.tzinfo is None:
			return value.replace(tzinfo=timezone.utc)
		return value

	if isinstance(value, str):
		try:
			return datetime.fromisoformat(value.replace('Z', '+00:00'))
		except ValueError:
			return None

	return None


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

	By default, fetches patches where EITHER deadwood_validated OR forest_cover_validated is true.
	Use flags to filter for specific validation types.

	For child patches without direct labels, resolves effective labels by traversing
	the full parent chain (5cm -> 10cm -> 20cm).
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

			response = query.order('dataset_id').order('resolution_cm').order('patch_index').execute()
			patches = response.data if response.data else []
			if not deadwood_only and not forest_cover_only:
				patches = [
					p
					for p in patches
					if bool(p.get('deadwood_validated')) or bool(p.get('forest_cover_validated'))
				]

			if not patches:
				return []

			# Build per-dataset parent maps so each validated patch can resolve effective
			# label IDs through the full ancestor chain.
			dataset_ids = sorted(set(p['dataset_id'] for p in patches))
			dataset_patch_maps: dict[int, dict[int, dict]] = {}
			for ds_id in dataset_ids:
				all_patches_response = (
					client.from_('reference_patches')
					.select('id, parent_tile_id, reference_deadwood_label_id, reference_forest_cover_label_id, updated_at')
					.eq('dataset_id', ds_id)
					.execute()
				)
				all_patches = all_patches_response.data if all_patches_response.data else []
				dataset_patch_maps[ds_id] = {row['id']: row for row in all_patches}

			for patch in patches:
				dataset_patch_map = dataset_patch_maps.get(patch['dataset_id'], {})
				patch_updated_at = parse_optional_datetime(patch.get('updated_at'))

				effective_deadwood_label_id = patch.get('reference_deadwood_label_id')
				effective_forest_label_id = patch.get('reference_forest_cover_label_id')
				effective_deadwood_updated_at = patch_updated_at if effective_deadwood_label_id else None
				effective_forest_updated_at = patch_updated_at if effective_forest_label_id else None

				parent_id = patch.get('parent_tile_id')
				visited_patch_ids = {patch.get('id')}

				while parent_id and (not effective_deadwood_label_id or not effective_forest_label_id):
					if parent_id in visited_patch_ids:
						# Guard against unexpected parent cycles.
						break
					visited_patch_ids.add(parent_id)

					parent_patch = dataset_patch_map.get(parent_id)
					if not parent_patch:
						break

					parent_updated_at = parse_optional_datetime(parent_patch.get('updated_at'))
					if not effective_deadwood_label_id and parent_patch.get('reference_deadwood_label_id'):
						effective_deadwood_label_id = parent_patch.get('reference_deadwood_label_id')
						effective_deadwood_updated_at = parent_updated_at

					if not effective_forest_label_id and parent_patch.get('reference_forest_cover_label_id'):
						effective_forest_label_id = parent_patch.get('reference_forest_cover_label_id')
						effective_forest_updated_at = parent_updated_at

					parent_id = parent_patch.get('parent_tile_id')

				# Keep legacy keys for downstream logic compatibility.
				if not patch.get('reference_deadwood_label_id') and effective_deadwood_label_id:
					patch['parent_deadwood_label_id'] = effective_deadwood_label_id
				if not patch.get('reference_forest_cover_label_id') and effective_forest_label_id:
					patch['parent_forestcover_label_id'] = effective_forest_label_id

				# Add explicit effective labels and a combined source-update timestamp.
				patch['effective_deadwood_label_id'] = effective_deadwood_label_id
				patch['effective_forestcover_label_id'] = effective_forest_label_id

				effective_update_candidates = [
					c
					for c in [patch_updated_at, effective_deadwood_updated_at, effective_forest_updated_at]
					if c is not None
				]
				if effective_update_candidates:
					patch['effective_reference_updated_at'] = max(effective_update_candidates)

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


def fetch_vector_features_by_label(token: str, patch_id: int, label_id: Optional[int], table_name: str) -> list[dict]:
	"""Fetch stored reference geometries for a root patch as EPSG:4326 GeoJSON features."""
	if label_id is None:
		return []

	try:
		with use_client(token) as client:
			response = (
				client.from_(table_name)
				.select('geometry, area_m2, properties')
				.eq('patch_id', patch_id)
				.eq('label_id', label_id)
				.execute()
			)
			return response.data if response.data else []
	except Exception as e:
		print(f'❌ Error fetching vector features for patch {patch_id}: {e}')
		return []


def build_filename_base(patch: dict) -> str:
	"""Build the common filename base used by raster and vector exports."""
	dataset_id = patch['dataset_id']
	resolution_cm = patch['resolution_cm']
	patch_index = patch['patch_index']

	tile_id = patch_index.split('_')[-2:] if '_' in patch_index else [patch_index]
	tile_id = '_'.join(tile_id) if len(tile_id) > 1 else tile_id[0]
	return f'{dataset_id}_{tile_id}_{resolution_cm}cm'


def patch_has_deadwood_reference(patch: dict) -> bool:
	"""Return whether this patch has a deadwood reference label in its effective chain."""
	return bool(
		patch.get('effective_deadwood_label_id')
		or patch.get('reference_deadwood_label_id')
		or patch.get('parent_deadwood_label_id')
	)


def patch_has_forestcover_reference(patch: dict) -> bool:
	"""Return whether this patch has a forest cover reference label in its effective chain."""
	return bool(
		patch.get('effective_forestcover_label_id')
		or patch.get('reference_forest_cover_label_id')
		or patch.get('parent_forestcover_label_id')
	)


def is_vector_export_eligible_patch(patch: dict) -> bool:
	"""Return whether a patch should produce a vector export."""
	return (
		patch.get('resolution_cm') == 20
		and patch.get('parent_tile_id') is None
		and (bool(patch.get('deadwood_validated')) or bool(patch.get('forest_cover_validated')))
	)


def get_vector_export_candidates(patches: list[dict], resolution_cm: Optional[int] = None) -> list[dict]:
	"""Return root/base patches that should be considered for GeoPackage export."""
	if resolution_cm in (5, 10):
		return []
	return [patch for patch in patches if is_vector_export_eligible_patch(patch)]


def fetch_latest_reference_geometry_created_at(token: str, patch_id: int) -> Optional[datetime]:
	"""Return the latest geometry creation timestamp for a reference patch."""
	latest_created_at = None

	try:
		with use_client(token) as client:
			for table_name in ('reference_patch_deadwood_geometries', 'reference_patch_forest_cover_geometries'):
				response = client.from_(table_name).select('created_at').eq('patch_id', patch_id).execute()
				for row in response.data or []:
					created_at = parse_optional_datetime(row.get('created_at'))
					if created_at and (latest_created_at is None or created_at > latest_created_at):
						latest_created_at = created_at
	except Exception as e:
		print(f'⚠️  Error fetching latest geometry timestamp for patch {patch_id}: {e}')

	return latest_created_at


def vector_export_needs_export(output_dir: Path, filename_base: str, latest_source_updated_at: datetime) -> bool:
	"""Check if a root patch vector export needs refresh."""
	gpkg_path = output_dir / 'gpkg' / f'{filename_base}.gpkg'
	metadata_path = output_dir / 'metadata' / f'{filename_base}_vector.json'

	if not gpkg_path.exists() or not metadata_path.exists():
		return True

	file_mtime = datetime.fromtimestamp(metadata_path.stat().st_mtime, tz=timezone.utc)
	return latest_source_updated_at > file_mtime


def normalize_polygon_geometry(geometry: dict) -> MultiPolygon:
	"""Normalize polygonal GeoJSON to MultiPolygon for stable GeoPackage schemas."""
	geom = shape(geometry)
	if geom.geom_type == 'Polygon':
		return MultiPolygon([geom])
	if geom.geom_type == 'MultiPolygon':
		return geom
	raise ValueError(f'Expected polygonal geometry, got {geom.geom_type}')


def build_base_patch_geodataframe(patch: dict) -> gpd.GeoDataFrame:
	"""Build the base_patch GeoDataFrame for a root patch boundary."""
	rows = [
		{
			'dataset_id': patch['dataset_id'],
			'patch_id': patch['id'],
			'patch_index': patch['patch_index'],
			'resolution_cm': patch['resolution_cm'],
			'layer_name': 'base_patch',
			'geometry': normalize_polygon_geometry(patch['geometry']),
		}
	]
	return gpd.GeoDataFrame(rows, geometry='geometry', crs='EPSG:4326')


def build_vector_layer_geodataframe(
	patch: dict,
	layer_name: str,
	label_id: Optional[int],
	rows: list[dict],
) -> gpd.GeoDataFrame:
	"""Build a GeoDataFrame for a validated reference layer."""
	features = []
	for index, row in enumerate(rows, start=1):
		try:
			properties_json = json.dumps(row.get('properties') or {}, sort_keys=True)
		except TypeError as exc:
			raise ValueError(
				f'Failed to serialize properties for {layer_name} feature {index} on patch {patch["patch_index"]}'
			) from exc

		try:
			geometry = normalize_polygon_geometry(row['geometry'])
		except (KeyError, TypeError, ValueError) as exc:
			raise ValueError(
				f'Invalid geometry for {layer_name} feature {index} on patch {patch["patch_index"]}'
			) from exc

		features.append(
			{
				'dataset_id': patch['dataset_id'],
				'patch_id': patch['id'],
				'patch_index': patch['patch_index'],
				'resolution_cm': patch['resolution_cm'],
				'label_id': label_id,
				'layer_name': layer_name,
				'validated': 1,
				'area_m2': row.get('area_m2'),
				'properties_json': properties_json,
				'geometry': geometry,
			}
		)

	if not features:
		return gpd.GeoDataFrame(
			columns=[
				'dataset_id',
				'patch_id',
				'patch_index',
				'resolution_cm',
				'label_id',
				'layer_name',
				'validated',
				'area_m2',
				'properties_json',
				'geometry',
			],
			geometry='geometry',
			crs='EPSG:4326',
		)

	return gpd.GeoDataFrame(features, geometry='geometry', crs='EPSG:4326')


def write_geopackage_layer(gpkg_path: Path, layer_name: str, gdf: gpd.GeoDataFrame, schema: Optional[dict] = None):
	"""Write a new GeoPackage layer, including empty layers with explicit schema."""
	kwargs = {'driver': 'GPKG', 'layer': layer_name, 'engine': 'fiona'}
	if schema is not None:
		kwargs['schema'] = schema
	gdf.to_file(gpkg_path, **kwargs)


def export_vector_geopackage(token: str, patch: dict, output_dir: Path) -> Optional[Path]:
	"""Export a root/base patch as a GeoPackage in EPSG:4326."""
	filename_base = build_filename_base(patch)
	gpkg_dir = output_dir / 'gpkg'
	gpkg_dir.mkdir(parents=True, exist_ok=True)
	metadata_dir = output_dir / 'metadata'
	metadata_dir.mkdir(parents=True, exist_ok=True)

	gpkg_path = gpkg_dir / f'{filename_base}.gpkg'
	temp_gpkg_path = gpkg_dir / f'{filename_base}.tmp.gpkg'
	metadata_path = metadata_dir / f'{filename_base}_vector.json'

	if temp_gpkg_path.exists():
		temp_gpkg_path.unlink()

	label_layer_schema = {
		'geometry': 'MultiPolygon',
		'properties': {
			'dataset_id': 'int',
			'patch_id': 'int',
			'patch_index': 'str',
			'resolution_cm': 'int',
			'label_id': 'int',
			'layer_name': 'str',
			'validated': 'int',
			'area_m2': 'float',
			'properties_json': 'str',
		},
	}
	base_patch_schema = {
		'geometry': 'MultiPolygon',
		'properties': {
			'dataset_id': 'int',
			'patch_id': 'int',
			'patch_index': 'str',
			'resolution_cm': 'int',
			'layer_name': 'str',
		},
	}

	try:
		write_geopackage_layer(temp_gpkg_path, 'base_patch', build_base_patch_geodataframe(patch), schema=base_patch_schema)

		layer_counts = {'base_patch': 1, 'deadwood': 0, 'forest_cover': 0}
		exported_layers = {'deadwood': False, 'forest_cover': False}

		if bool(patch.get('deadwood_validated')):
			deadwood_label_id = patch.get('reference_deadwood_label_id')
			deadwood_rows = fetch_vector_features_by_label(
				token,
				patch['id'],
				deadwood_label_id,
				'reference_patch_deadwood_geometries',
			)
			deadwood_gdf = build_vector_layer_geodataframe(patch, 'deadwood', deadwood_label_id, deadwood_rows)
			write_geopackage_layer(temp_gpkg_path, 'deadwood', deadwood_gdf, schema=label_layer_schema)
			layer_counts['deadwood'] = len(deadwood_gdf.index)
			exported_layers['deadwood'] = True

		if bool(patch.get('forest_cover_validated')):
			forest_label_id = patch.get('reference_forest_cover_label_id')
			forest_rows = fetch_vector_features_by_label(
				token,
				patch['id'],
				forest_label_id,
				'reference_patch_forest_cover_geometries',
			)
			forest_gdf = build_vector_layer_geodataframe(patch, 'forest_cover', forest_label_id, forest_rows)
			write_geopackage_layer(temp_gpkg_path, 'forest_cover', forest_gdf, schema=label_layer_schema)
			layer_counts['forest_cover'] = len(forest_gdf.index)
			exported_layers['forest_cover'] = True

		temp_gpkg_path.replace(gpkg_path)

		metadata = {
			'dataset_id': patch['dataset_id'],
			'patch_id': patch['id'],
			'patch_index': patch['patch_index'],
			'resolution_cm': patch['resolution_cm'],
			'crs': 'EPSG:4326',
			'layers': exported_layers,
			'validation': {
				'deadwood_validated': bool(patch.get('deadwood_validated')),
				'forest_cover_validated': bool(patch.get('forest_cover_validated')),
			},
			'feature_counts': layer_counts,
		}
		with open(metadata_path, 'w') as f:
			json.dump(metadata, f, indent=2)

		return gpkg_path
	except Exception as e:
		print(f"❌ Error exporting vector GeoPackage for patch {patch['patch_index']}: {e}")
		import traceback

		traceback.print_exc()
		if temp_gpkg_path.exists():
			temp_gpkg_path.unlink()
		return None


def patch_needs_export(
	output_dir: Path,
	filename_base: str,
	patch_updated_at: datetime,
	has_deadwood_ref: bool,
	has_forestcover_ref: bool,
	effective_reference_updated_at: Optional[datetime] = None,
) -> bool:
	"""Check if patch needs to be exported based on timestamps.

	Args:
		output_dir: Base output directory for the dataset
		filename_base: Base filename (e.g., "420_0_0_5cm")
		patch_updated_at: When the patch was last updated in the database
		effective_reference_updated_at: Latest ancestor label update time that can
			change this patch's exported masks
		has_deadwood_ref: Whether deadwood reference masks should exist
		has_forestcover_ref: Whether forest cover reference masks should exist

	Returns:
		True if patch should be exported (files missing or outdated), False otherwise
	"""
	json_path = output_dir / 'metadata' / f'{filename_base}.json'

	# If metadata file doesn't exist, needs export
	if not json_path.exists():
		return True

	# Compare file modification time with patch updated_at
	file_mtime = datetime.fromtimestamp(json_path.stat().st_mtime, tz=timezone.utc)
	latest_update = patch_updated_at
	if effective_reference_updated_at and effective_reference_updated_at > latest_update:
		latest_update = effective_reference_updated_at

	# If patch was updated after file was written, needs re-export
	if latest_update > file_mtime:
		return True

	# Check other required files exist
	geotiff_path = output_dir / 'geotiff' / f'{filename_base}.tif'
	png_path = output_dir / 'png' / f'{filename_base}.png'

	if not (geotiff_path.exists() and png_path.exists()):
		return True

	# Check reference masks only for label types that actually exist.
	# Some validated patches legitimately have only one label type.
	if has_deadwood_ref:
		deadwood_ref_files = [
			output_dir / 'geotiff' / f'{filename_base}_deadwood_ref.tif',
			output_dir / 'png' / f'{filename_base}_deadwood_ref.png',
		]
		if not all(f.exists() for f in deadwood_ref_files):
			return True

	if has_forestcover_ref:
		forestcover_ref_files = [
			output_dir / 'geotiff' / f'{filename_base}_forestcover_ref.tif',
			output_dir / 'png' / f'{filename_base}_forestcover_ref.png',
		]
		if not all(f.exists() for f in forestcover_ref_files):
			return True

	return False


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
		deadwood_ref_label_id = (
			patch.get('effective_deadwood_label_id')
			or patch.get('reference_deadwood_label_id')
			or patch.get('parent_deadwood_label_id')
		)
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
		forestcover_ref_label_id = (
			patch.get('effective_forestcover_label_id')
			or patch.get('reference_forest_cover_label_id')
			or patch.get('parent_forestcover_label_id')
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
		filename_base = build_filename_base(patch)

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

	# Pre-filter patches that actually need export. This keeps no-change cron runs
	# compact and avoids printing the full dataset breakdown every time.
	raster_export_candidates = []
	raster_skipped_count = 0
	vector_candidates = get_vector_export_candidates(patches, resolution_cm=args.resolution)
	vector_export_candidates = []
	vector_skipped_count = 0

	for patch in patches:
		dataset_id = patch['dataset_id']
		dataset_output_dir = output_base_dir / str(dataset_id)
		filename_base = build_filename_base(patch)

		has_deadwood_ref = patch_has_deadwood_reference(patch)
		has_forestcover_ref = patch_has_forestcover_reference(patch)

		patch_updated_at = parse_optional_datetime(patch.get('updated_at'))
		if patch_updated_at is None:
			patch_updated_at = datetime.fromtimestamp(0, tz=timezone.utc)
		effective_reference_updated_at = parse_optional_datetime(patch.get('effective_reference_updated_at'))

		if not args.force and not patch_needs_export(
			dataset_output_dir,
			filename_base,
			patch_updated_at,
			has_deadwood_ref,
			has_forestcover_ref,
			effective_reference_updated_at=effective_reference_updated_at,
		):
			raster_skipped_count += 1
		else:
			raster_export_candidates.append(patch)

	for patch in vector_candidates:
		dataset_output_dir = output_base_dir / str(patch['dataset_id'])
		filename_base = build_filename_base(patch)
		patch_updated_at = parse_optional_datetime(patch.get('updated_at'))
		if patch_updated_at is None:
			patch_updated_at = datetime.fromtimestamp(0, tz=timezone.utc)
		geometry_created_at = fetch_latest_reference_geometry_created_at(token, patch['id'])
		latest_vector_source_updated_at = patch_updated_at
		if geometry_created_at and geometry_created_at > latest_vector_source_updated_at:
			latest_vector_source_updated_at = geometry_created_at

		if not args.force and not vector_export_needs_export(
			dataset_output_dir,
			filename_base,
			latest_vector_source_updated_at,
		):
			vector_skipped_count += 1
		else:
			vector_export_candidates.append(patch)

	if not raster_export_candidates and not vector_export_candidates:
		print('✅ No patch changes detected; export skipped.')
		print('   Newly exported (raster): 0 patches')
		print(f'   Skipped raster (already exist): {raster_skipped_count} patches')
		print('   Newly exported (vector): 0 geopackages')
		print(f'   Skipped vector (already exist): {vector_skipped_count} geopackages')
		return 0

	print(f'✓ Found {len(patches)} validated patches in database')
	print(f'   Need raster export: {len(raster_export_candidates)} patches')
	print(f'   Raster already up-to-date: {raster_skipped_count} patches')
	print(f'   Need vector export: {len(vector_export_candidates)} geopackages')
	print(f'   Vector already up-to-date: {vector_skipped_count} geopackages\n')

	# Group only export candidates by dataset/resolution for readable change summary.
	by_dataset = {}
	for patch in raster_export_candidates:
		dataset_id = patch['dataset_id']
		resolution = patch['resolution_cm']

		if dataset_id not in by_dataset:
			by_dataset[dataset_id] = {}
		if resolution not in by_dataset[dataset_id]:
			by_dataset[dataset_id][resolution] = 0
		by_dataset[dataset_id][resolution] += 1

	print('📊 Patches to export by dataset:')
	for dataset_id in sorted(by_dataset.keys()):
		resolutions = by_dataset[dataset_id]
		res_str = ', '.join([f'{count}x{res}cm' for res, count in sorted(resolutions.items())])
		print(f'  Dataset {dataset_id}: {res_str}')
	if vector_export_candidates:
		vector_by_dataset = {}
		for patch in vector_export_candidates:
			vector_by_dataset.setdefault(patch['dataset_id'], 0)
			vector_by_dataset[patch['dataset_id']] += 1
		print('📦 Root patch GeoPackages to export:')
		for dataset_id in sorted(vector_by_dataset.keys()):
			print(f"  Dataset {dataset_id}: {vector_by_dataset[dataset_id]}x gpkg")
	print()

	# Export patches
	print('🚀 Exporting patches...')

	# Track COG URLs, AOI geometries we've already fetched per dataset
	cog_cache: dict[int, tuple[str, dict]] = {}  # dataset_id -> (cog_url, cog_info)
	aoi_cache: dict[int, Optional[dict]] = {}

	success_count = 0
	failed_count = 0
	for patch in tqdm(raster_export_candidates, desc='Exporting raster patches'):
		dataset_id = patch['dataset_id']
		resolution_cm = patch['resolution_cm']

		# GSD mapping
		gsd_map = {20: 0.20, 10: 0.10, 5: 0.05}
		target_gsd = gsd_map[resolution_cm]

		# Dataset-specific output directory structure
		dataset_output_dir = output_base_dir / str(dataset_id)

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

	vector_success_count = 0
	vector_failed_count = 0
	for patch in tqdm(vector_export_candidates, desc='Exporting vector GeoPackages'):
		dataset_output_dir = output_base_dir / str(patch['dataset_id'])
		result = export_vector_geopackage(token, patch, dataset_output_dir)
		if result:
			vector_success_count += 1
		else:
			vector_failed_count += 1

	# Print summary
	print('\n✅ Export complete!')
	print(f'   Newly exported raster: {success_count} patches')
	print(f'   Skipped raster (already exist): {raster_skipped_count} patches')
	if failed_count > 0:
		print(f'   Failed raster: {failed_count} patches')
	print(f'   Newly exported vector: {vector_success_count} geopackages')
	print(f'   Skipped vector (already exist): {vector_skipped_count} geopackages')
	if vector_failed_count > 0:
		print(f'   Failed vector: {vector_failed_count} geopackages')
	print('\n📁 Output structure:')
	print(f'   {output_base_dir.absolute()}/<dataset_id>/geotiff/')
	print(f'   {output_base_dir.absolute()}/<dataset_id>/png/')
	print(f'   {output_base_dir.absolute()}/<dataset_id>/gpkg/')
	print(f'   {output_base_dir.absolute()}/<dataset_id>/metadata/')

	return 0 if failed_count == 0 and vector_failed_count == 0 else 1


if __name__ == '__main__':
	sys.exit(main())
