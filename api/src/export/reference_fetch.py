"""Database reads for the reference-patch export.

Every function here lets database errors propagate. A failed read must fail the
patch (or the run) that depends on it; it must never look like "no geometries",
because the exporter would then write an empty mask as human-validated truth.
"""

from datetime import datetime, timezone
from typing import Optional

from pyproj import Transformer
from shapely.geometry import box, shape
from shapely.ops import transform as shapely_transform

from shared.db import use_client
from shared.pagination import fetch_all_rows
from shared.settings import settings


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
	"""Fetch the IDs of public datasets in the reference_datasets table.

	The export directory is served without authentication, so view-only and private
	datasets must never be written to it (their orthophotos are not downloadable by
	everyone). Leaving them out here also makes the export remove their old folders.
	"""
	with use_client(token) as client:
		rows = fetch_all_rows(lambda: client.from_('reference_datasets').select('dataset_id').order('dataset_id'))
		reference_ids = [row['dataset_id'] for row in rows]
		if not reference_ids:
			return []
		public_rows = fetch_all_rows(
			lambda: client.from_('v2_datasets')
			.select('id')
			.in_('id', reference_ids)
			.eq('data_access', 'public')
			.order('id')
		)
	return [row['id'] for row in public_rows]


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
	dataset_ids = fetch_reference_datasets(token)
	if dataset_id:
		dataset_ids = [dataset_id] if dataset_id in dataset_ids else []
	if not dataset_ids:
		return []

	with use_client(token) as client:

		def validated_query():
			query = client.from_('reference_patches').select('*').in_('dataset_id', dataset_ids)
			if resolution_cm:
				query = query.eq('resolution_cm', resolution_cm)
			if deadwood_only:
				query = query.eq('deadwood_validated', True)
			elif forest_cover_only:
				query = query.eq('forest_cover_validated', True)
			return query.order('dataset_id').order('resolution_cm').order('patch_index').order('id')

		patches = fetch_all_rows(validated_query)
		if not deadwood_only and not forest_cover_only:
			patches = [p for p in patches if bool(p.get('deadwood_validated')) or bool(p.get('forest_cover_validated'))]

		if not patches:
			return []

		# Build per-dataset parent maps so each validated patch can resolve effective
		# label IDs through the full ancestor chain.
		dataset_patch_maps: dict[int, dict[int, dict]] = {}
		for ds_id in sorted(set(p['dataset_id'] for p in patches)):
			all_patches = fetch_all_rows(
				lambda: (
					client.from_('reference_patches')
					.select(
						'id, parent_tile_id, reference_deadwood_label_id, reference_forest_cover_label_id, updated_at'
					)
					.eq('dataset_id', ds_id)
					.order('id')
				)
			)
			dataset_patch_maps[ds_id] = {row['id']: row for row in all_patches}

	for patch in patches:
		resolve_effective_labels(patch, dataset_patch_maps.get(patch['dataset_id'], {}))
	return patches


def resolve_effective_labels(patch: dict, dataset_patch_map: dict[int, dict]):
	"""Add the effective label IDs and source timestamp inherited from ancestors."""
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
		c for c in [patch_updated_at, effective_deadwood_updated_at, effective_forest_updated_at] if c is not None
	]
	if effective_update_candidates:
		patch['effective_reference_updated_at'] = max(effective_update_candidates)


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
	"""Fetch the latest AOI geometry for a dataset; None only when none exists."""
	with use_client(token) as client:
		response = (
			client.from_('v2_aois')
			.select('geometry')
			.eq('dataset_id', dataset_id)
			.order('created_at', desc=True)
			.limit(1)
			.execute()
		)
	if response.data:
		return response.data[0]['geometry']
	return None


def fetch_geometries_by_label(token: str, label_id: int, table_name: str, bbox: tuple, epsg_code: int) -> list:
	"""Fetch reference geometries for a label that intersect bbox, in the patch's UTM CRS.

	Raises ValueError when a stored geometry cannot be parsed or reprojected.
	"""
	with use_client(token) as client:
		rows = fetch_all_rows(
			lambda: client.from_(table_name).select('id, geometry').eq('label_id', label_id).order('id')
		)

	transformer = Transformer.from_crs('EPSG:4326', f'EPSG:{epsg_code}', always_xy=True)
	tile_box = box(*bbox)
	geometries = []
	for row in rows:
		try:
			geom_utm = shapely_transform(transformer.transform, shape(row['geometry']))
		except Exception as exc:
			raise ValueError(f'Invalid geometry {row.get("id")} in {table_name} for label {label_id}') from exc
		if geom_utm.intersects(tile_box):
			geometries.append(geom_utm)
	return geometries


def fetch_vector_features_by_label(token: str, patch_id: int, label_id: Optional[int], table_name: str) -> list[dict]:
	"""Fetch stored reference geometries for a root patch as EPSG:4326 GeoJSON features."""
	if label_id is None:
		return []

	with use_client(token) as client:
		return fetch_all_rows(
			lambda: (
				client.from_(table_name)
				.select('id, geometry, area_m2, properties')
				.eq('patch_id', patch_id)
				.eq('label_id', label_id)
				.order('id')
			)
		)


def fetch_latest_reference_geometry_created_at(token: str, patch_id: int) -> Optional[datetime]:
	"""Return the latest geometry creation timestamp for a reference patch."""
	latest_created_at = None

	with use_client(token) as client:
		for table_name in ('reference_patch_deadwood_geometries', 'reference_patch_forest_cover_geometries'):
			response = (
				client.from_(table_name)
				.select('created_at')
				.eq('patch_id', patch_id)
				.order('created_at', desc=True)
				.limit(1)
				.execute()
			)
			for row in response.data or []:
				created_at = parse_optional_datetime(row.get('created_at'))
				if created_at and (latest_created_at is None or created_at > latest_created_at):
					latest_created_at = created_at

	return latest_created_at
