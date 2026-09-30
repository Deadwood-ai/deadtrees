import zipfile
import io
import tempfile
import json
from pathlib import Path
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple, Union

import geopandas as gpd
import yaml
import pandas as pd

from shared.logging import UnifiedLogger
from shared.settings import settings
from shared.db import use_service_client
from shared.pagination import fetch_all_rows, iter_pages
from shared.models import Label, Dataset, LicenseEnum, LabelDataEnum, LabelSourceEnum
from shared.labels import get_model_preferences

TEMPLATE_PATH = Path(__file__).parent / 'templates'

# Base URL for deadtrees dataset links
DEADTREES_BASE_URL = 'https://deadtrees.earth/datasets'

# Create a proper logger
logger = UnifiedLogger(__name__)


EXPORTABLE_LABEL_SOURCES = {
	LabelSourceEnum.model_prediction,
	LabelSourceEnum.visual_interpretation,
}


@dataclass(frozen=True)
class ExportScope:
	"""The labels and AOIs of one dataset that the requesting user may read.

	Read with the user's token, so the label policies (archived datasets, datasets
	excluded by their audit) decide what a download contains. The background build
	has no user session and reads only the geometries of these labels.
	"""

	labels: List[Label]
	aois: List[Dict]


def read_export_scope(client, dataset_id: int) -> ExportScope:
	"""Read the labels and AOIs visible to the client's user."""
	labels = fetch_all_rows(lambda: client.table(settings.labels_table).select('*').eq('dataset_id', dataset_id).order('id'))
	aois = fetch_all_rows(lambda: client.table(settings.aois_table).select('*').eq('dataset_id', dataset_id).order('id'))
	return ExportScope(labels=[Label(**label) for label in labels], aois=aois)


# =============================================================================
# Multi-Dataset Bundle Helpers
# =============================================================================


def get_unique_archive_name(base_name: str, used_names: Set[str]) -> str:
	"""
	Return a unique filename, adding _2, _3, etc. suffix if collision exists.
	
	Args:
		base_name: The desired filename (e.g., "flight_data.tif")
		used_names: Set of already-used names in the archive
		
	Returns:
		Unique filename (original if no collision, or with suffix)
	"""
	if base_name not in used_names:
		return base_name
	
	# Split into stem and suffix
	path = Path(base_name)
	stem = path.stem
	suffix = path.suffix
	
	# Find next available number
	counter = 2
	while True:
		candidate = f"{stem}_{counter}{suffix}"
		if candidate not in used_names:
			return candidate
		counter += 1


def get_ortho_base_filename(dataset: Dataset, use_original: bool = True) -> str:
	"""
	Get the base filename for an ortho file.
	
	Args:
		dataset: The dataset object
		use_original: If True, use original filename; if False, use ID-based name
		
	Returns:
		Base filename with .tif extension
	"""
	if not use_original:
		return f"ortho_{dataset.id}.tif"
	
	if dataset.file_name:
		# Get stem (handles both .tif and .zip files from ODM)
		stem = Path(dataset.file_name).stem.strip()
		if stem:
			return f"{stem}.tif"
	
	# Fallback to ID-based name
	return f"ortho_{dataset.id}.tif"


def build_dataset_metadata_row(
	dataset: Dataset,
	ortho: Dict,
	metadata: Optional[Dict],
) -> Dict:
	"""
	Build a single row of metadata for one dataset in a multi-dataset bundle.
	
	Args:
		dataset: The Dataset object
		ortho: The ortho record from v2_orthos
		metadata: The metadata record from v2_metadata (optional)
		
	Returns:
		Dict with all metadata fields for this dataset
	"""
	# Extract structured metadata fields for download bundles.
	metadata_blob = metadata.get('metadata') if isinstance(metadata, dict) else None
	metadata_blob = metadata_blob if isinstance(metadata_blob, dict) else {}
	gadm = metadata_blob.get('gadm') if isinstance(metadata_blob.get('gadm'), dict) else {}
	biome = metadata_blob.get('biome') if isinstance(metadata_blob.get('biome'), dict) else {}
	phenology = metadata_blob.get('phenology') if isinstance(metadata_blob.get('phenology'), dict) else {}

	admin_levels = {
		'admin_level_0': gadm.get('admin_level_1'),  # Country (GADM naming is off-by-one)
		'admin_level_1': gadm.get('admin_level_2'),
		'admin_level_2': gadm.get('admin_level_3'),
		'admin_level_3': gadm.get('admin_level_4'),
	}
	
	# Extract centroid from ortho bbox
	centroid_lat = None
	centroid_lon = None
	if ortho and ortho.get('bbox'):
		bbox_str = ortho['bbox']
		# Parse BOX(left bottom, right top) format
		if bbox_str and bbox_str.startswith('BOX('):
			try:
				coords = bbox_str.replace('BOX(', '').replace(')', '')
				ll, ur = coords.split(',')
				left, bottom = map(float, ll.strip().split(' '))
				right, top = map(float, ur.strip().split(' '))
				centroid_lon = (left + right) / 2
				centroid_lat = (bottom + top) / 2
			except (ValueError, IndexError):
				pass
	
	# Extract GSD from ortho_info if available
	gsd_cm = None
	if ortho and ortho.get('ortho_info'):
		ortho_info = ortho['ortho_info']
		if isinstance(ortho_info, dict):
			# GSD might be in different places depending on processing
			gsd_cm = ortho_info.get('gsd_cm') or ortho_info.get('gsd')
	
	# Format capture date
	capture_date = None
	if dataset.aquisition_year:
		parts = [str(dataset.aquisition_year)]
		if dataset.aquisition_month:
			parts.append(f"{dataset.aquisition_month:02d}")
			if dataset.aquisition_day:
				parts.append(f"{dataset.aquisition_day:02d}")
		capture_date = '-'.join(parts)
	
	return {
		'deadtrees_id': dataset.id,
		'deadtrees_url': f"{DEADTREES_BASE_URL}/{dataset.id}",
		'file_name': dataset.file_name,
		'capture_date': capture_date,
		'gsd_cm': gsd_cm,
		'sensor_platform': dataset.platform.value if dataset.platform else None,
		'license': dataset.license.value if dataset.license else None,
		'authors': ', '.join(dataset.authors) if dataset.authors else None,
		'admin_level_0': admin_levels.get('admin_level_0'),
		'admin_level_1': admin_levels.get('admin_level_1'),
		'admin_level_2': admin_levels.get('admin_level_2'),
		'admin_level_3': admin_levels.get('admin_level_3'),
		'gadm_source': gadm.get('source'),
		'gadm_version': gadm.get('version'),
		'biome_id': biome.get('biome_id'),
		'biome_name': biome.get('biome_name'),
		'biome_source': biome.get('source'),
		'biome_version': biome.get('version'),
		'phenology_source': phenology.get('source'),
		'phenology_version': phenology.get('version'),
		'has_phenology_curve': isinstance(phenology.get('phenology_curve'), list)
		and len(phenology['phenology_curve']) > 0,
		'metadata_version': metadata.get('version') if isinstance(metadata, dict) else None,
		'metadata_created_at': metadata.get('created_at') if isinstance(metadata, dict) else None,
		'centroid_lat': centroid_lat,
		'centroid_lon': centroid_lon,
		'additional_information': dataset.additional_information,
	}


def build_single_dataset_metadata_row(
	dataset: Dataset,
	ortho: Optional[Dict],
	metadata: Optional[Dict],
) -> Dict:
	"""Build the METADATA row for a single-dataset ZIP bundle."""
	row = dataset.model_dump(exclude={'created_at'})
	row.update(build_dataset_metadata_row(dataset, ortho or {}, metadata))

	# Keep the raw metadata blob accessible without forcing callers to query the DB separately.
	metadata_blob = metadata.get('metadata') if isinstance(metadata, dict) else None
	if metadata_blob is not None:
		row['metadata_json'] = json.dumps(metadata_blob, sort_keys=True)
	else:
		row['metadata_json'] = None

	return row


def _write_metadata_tables(archive: zipfile.ZipFile, df: pd.DataFrame, include_parquet: bool) -> None:
	archive.writestr('METADATA.csv', df.to_csv(index=False))
	if include_parquet:
		archive.writestr('METADATA.parquet', df.to_parquet(index=False))


def _write_license_and_citation(archive: zipfile.ZipFile, datasets: List[Dataset]) -> None:
	archive.writestr('LICENSE.txt', create_license_text(datasets))
	citation_buffer = io.StringIO()
	create_citation_file(datasets, citation_buffer)
	archive.writestr('CITATION.cff', citation_buffer.getvalue())


def _write_label_geopackages(archive: zipfile.ZipFile, dataset_id: int, scope: ExportScope) -> None:
	"""Add one GeoPackage per label type (with the dataset's AOI layer) to the archive."""
	labels = get_exportable_labels(scope)
	with tempfile.TemporaryDirectory() as temp_dir:
		for label_type in sorted({label.label_data for label in labels}, key=lambda value: value.value):
			label_file = Path(temp_dir) / f'{label_type.value}_{dataset_id}.gpkg'
			for label in labels:
				if label.label_data == label_type:
					label_to_geopackage(str(label_file), label)
			export_dataset_aois(scope.aois, str(label_file))
			archive.write(label_file, arcname=f'labels_{label_type.value}_{dataset_id}.gpkg')
			logger.info(f'Added {label_type.value} labels to bundle for dataset {dataset_id}')


def bundle_multi_dataset(
	target_path: str,
	datasets_info: List[Tuple[Dataset, Dict, Optional[Dict], str]],
	label_scopes: Optional[Dict[int, ExportScope]] = None,
	include_parquet: bool = False,
	use_original_filename: bool = True,
) -> str:
	"""
	Bundle multiple datasets into a single ZIP archive.

	Args:
		target_path: Path to write the ZIP file
		datasets_info: List of tuples (dataset, ortho_dict, metadata_dict, archive_file_path)
		label_scopes: Per dataset ID, the labels and AOIs to include; None bundles no labels
		include_parquet: Whether to include METADATA.parquet
		use_original_filename: If True, use original filenames for orthos; if False, use ortho_{id}.tif

	Returns:
		Path to the created ZIP file

	Raises:
		FileNotFoundError: If an ortho file is missing; an incomplete bundle is never produced.
	"""
	if not datasets_info:
		raise ValueError("No datasets provided for bundling")

	missing = [dataset.id for dataset, _, _, file_path in datasets_info if not Path(file_path).exists()]
	if missing:
		raise FileNotFoundError(f'Ortho file missing for datasets {missing}')

	# Track used filenames to handle collisions
	used_names: Set[str] = set()
	metadata_rows = []
	ortho_entries = []  # (archive_name, file_path)

	for dataset, ortho, metadata, archive_file_path in datasets_info:
		unique_name = get_unique_archive_name(get_ortho_base_filename(dataset, use_original_filename), used_names)
		used_names.add(unique_name)
		ortho_entries.append((unique_name, archive_file_path))

		row = build_dataset_metadata_row(dataset, ortho, metadata)
		row['citation_doi'] = dataset.citation_doi
		row['bundle_filename'] = unique_name  # Track which file in bundle
		metadata_rows.append(row)

	with zipfile.ZipFile(target_path, 'w', zipfile.ZIP_STORED) as archive:
		for archive_name, file_path in ortho_entries:
			archive.write(file_path, arcname=archive_name)
			logger.info(f"Added {archive_name} to multi-dataset bundle")

		_write_metadata_tables(archive, pd.DataFrame(metadata_rows), include_parquet)
		_write_license_and_citation(archive, [dataset for dataset, _, _, _ in datasets_info])

		if label_scopes is not None:
			for dataset, _, _, _ in datasets_info:
				_write_label_geopackages(archive, dataset.id, label_scopes[dataset.id])

	logger.info(f"Created multi-dataset bundle with {len(datasets_info)} datasets at {target_path}")
	return target_path


# Geometry reads run with the service client: the background build has no user
# session, and it only reads geometries of labels in the user's ExportScope.


def label_to_geopackage(label_file, label: Label) -> io.BytesIO:
	"""Convert a single label to GeoPackage format"""
	# Geometries of a label from the user's ExportScope (service client, see note above)
	with use_service_client() as client:
		if label.label_data == LabelDataEnum.deadwood:
			geom_table = settings.deadwood_geometries_table
		else:
			geom_table = settings.forest_cover_geometries_table

		# Check if file already exists to determine if we need to append
		path = Path(label_file)
		file_exists = path.exists()

		# Create a layer name based on label type and source to group similar labels
		# This allows us to have separate layers for visual_interpretation and model_prediction
		layer_name = f'{label.label_data.value}_{label.label_source.value}'

		# Check if this layer already exists in the file
		existing_layers = []
		if file_exists:
			try:
				import fiona

				existing_layers = fiona.listlayers(label_file)
			except Exception:
				# File might exist but not be a valid GeoPackage yet
				pass

		layer_exists = layer_name in existing_layers
		total_geometries = 0

		# Stream each page to disk to keep memory bounded.
		pages = iter_pages(
			lambda: client.table(geom_table)
			.select('*')
			.eq('label_id', label.id)
			# Treat NULL as "not deleted" (IS NOT TRUE); the column has no NOT NULL constraint.
			.not_.is_('is_deleted', 'true')
			.order('id')
		)
		for page in pages:
			total_geometries += len(page)

			features = []
			for geom in page:
				geom_properties = geom.get('properties', {}) or {}
				features.append(
					{
						'type': 'Feature',
						'geometry': geom['geometry'],
						'properties': {
							'source': label.label_source,
							'type': label.label_type,
							'quality': label.label_quality,
							'label_id': label.id,
							**geom_properties,
						},
					}
				)

			label_gdf = gpd.GeoDataFrame.from_features(features)
			label_gdf.set_crs('EPSG:4326', inplace=True)

			if layer_exists:
				try:
					# Fast path: append batch to existing layer without re-reading old rows
					label_gdf.to_file(label_file, driver='GPKG', layer=layer_name, mode='a')
				except Exception as append_error:
					# Fallback for environments where append mode is unsupported
					logger.warning(
						f'Append mode failed for layer {layer_name}, falling back to read+concat: {append_error}'
					)
					existing_gdf = gpd.read_file(label_file, layer=layer_name)
					combined_gdf = pd.concat([existing_gdf, label_gdf], ignore_index=True)
					combined_gdf.to_file(label_file, driver='GPKG', layer=layer_name)
			else:
				label_gdf.to_file(label_file, driver='GPKG', layer=layer_name)
				layer_exists = True

			if total_geometries % 10000 == 0:
				logger.info(f'Fetched and wrote {total_geometries} geometries for label {label.id}')

		if total_geometries == 0:
			raise ValueError(f'No geometries found for label {label.id}')

		logger.info(f'Successfully fetched and wrote {total_geometries} geometries for label {label.id}')

		# Get AOI data only if aoi_id exists
		if label.aoi_id is not None:
			aoi_response = client.table(settings.aois_table).select('*').eq('id', label.aoi_id).execute()
			if aoi_response.data:
				aoi = aoi_response.data[0]
				aoi_gdf = gpd.GeoDataFrame.from_features(
					[
						{
							'type': 'Feature',
							'geometry': aoi['geometry'],
							'properties': {
								'dataset_id': label.dataset_id,
								'image_quality': aoi.get('image_quality'),
								'notes': aoi.get('notes'),
								'label_id': label.id,
							},
						}
					]
				)
				aoi_gdf.set_crs('EPSG:4326', inplace=True)

				# Use a consistent layer name for AOI - aoi_{label_data}
				aoi_layer_name = f'aoi_{label.label_data.value}'

				# Check if AOI layer already exists
				if aoi_layer_name in existing_layers:
					# Skip adding duplicate AOI since we only need one per label type
					pass
				else:
					aoi_gdf.to_file(label_file, driver='GPKG', layer=aoi_layer_name)

	return label_file


def filter_exportable_dataset_labels(
	labels: List[Label], preferences: Dict[LabelDataEnum, Dict]
) -> List[Label]:
	"""Keep only exportable label sources, and for model predictions only the preferred model version."""
	result = []
	for label in labels:
		if not label.is_active:
			continue
		if label.label_source not in EXPORTABLE_LABEL_SOURCES:
			continue
		if label.label_source == LabelSourceEnum.model_prediction:
			if label.label_data not in preferences:
				# No preference configured - skip model predictions for this layer type.
				continue
			preferred = preferences[label.label_data]
			if label.model_metadata != preferred:
				continue
		result.append(label)

	skipped_count = len(labels) - len(result)
	if skipped_count:
		logger.info(f'Skipping {skipped_count} non-exportable labels during bundle generation')

	return result


def get_exportable_labels(scope: ExportScope) -> List[Label]:
	"""Drop unsupported sources and non-preferred model versions from the user's labels."""
	return filter_exportable_dataset_labels(scope.labels, get_model_preferences())


def create_citation_file(datasets: Union[Dataset, List[Dataset]], filestream=None) -> str:
	"""Write CITATION.cff; a multi-dataset bundle cites every dataset's authors, DOI and license."""
	datasets = [datasets] if isinstance(datasets, Dataset) else datasets

	# load the template
	with open(TEMPLATE_PATH / 'CITATION.cff', 'r') as f:
		template = yaml.safe_load(f)

	if len(datasets) == 1:
		template['title'] = f'Deadwood Training Dataset: {datasets[0].file_name}'
	else:
		template['title'] = f'Deadwood Training Datasets ({len(datasets)} datasets)'

	# authors of every dataset (first occurrence wins), then the authors defined in the template
	authors = dict.fromkeys(author for dataset in datasets for author in (dataset.authors or []))
	template['authors'] = [*({'name': author} for author in authors), *template['authors']]

	identifiers = [
		{'type': 'doi', 'value': dataset.citation_doi, 'description': f'The DOI of the original dataset {dataset.id}.'}
		for dataset in datasets
		if dataset.citation_doi is not None
	]
	if identifiers:
		template['identifiers'] = identifiers

	licenses = list(dict.fromkeys(f'{dataset.license.value}-4.0'.upper() for dataset in datasets))
	template['license'] = licenses[0] if len(licenses) == 1 else licenses

	# create a buffer to write to
	if filestream is None:
		filestream = io.StringIO()
	yaml.dump(template, filestream)

	return filestream


def create_license_file(license_enum: LicenseEnum) -> str:
	"""Create license file content based on the license type"""
	license_file = TEMPLATE_PATH / f'{license_enum.value.replace(" ", "-")}.txt'
	if not license_file.exists():
		raise ValueError(f'License template file not found for {license_enum.value}')

	with open(license_file, 'r') as f:
		return f.read()


def create_license_text(datasets: List[Dataset]) -> str:
	"""LICENSE.txt content: the license text, or for mixed licenses each text with its datasets."""
	dataset_ids_by_license: Dict[LicenseEnum, List[int]] = {}
	for dataset in datasets:
		dataset_ids_by_license.setdefault(dataset.license, []).append(dataset.id)

	if len(dataset_ids_by_license) == 1:
		return create_license_file(next(iter(dataset_ids_by_license)))

	summary = ['This bundle contains datasets under different licenses.', 'Each dataset is licensed as follows:', '']
	sections = []
	for license_enum, dataset_ids in dataset_ids_by_license.items():
		ids = ', '.join(str(dataset_id) for dataset_id in dataset_ids)
		summary.append(f'- {license_enum.value}: datasets {ids}')
		sections.append(f'{"=" * 72}\n{license_enum.value} (datasets {ids})\n{"=" * 72}\n\n{create_license_file(license_enum)}')
	return '\n'.join(summary) + '\n\n' + '\n\n'.join(sections)


def bundle_dataset(
	target_path: str,
	archive_file_path: str,
	dataset: Dataset,
	ortho: Optional[Dict] = None,
	metadata: Optional[Dict] = None,
	include_parquet: bool = True,
	labels: Optional[ExportScope] = None,
	use_original_filename: bool = False,
):
	"""Bundle dataset files into a ZIP archive, with the given labels when there are any"""
	# Generate formatted filename base
	base_filename = f'ortho_{dataset.id}'
	if use_original_filename and dataset.file_name:
		stem = Path(dataset.file_name).stem.strip()
		if stem:
			base_filename = stem

	with zipfile.ZipFile(target_path, 'w', zipfile.ZIP_STORED) as archive:
		archive.write(archive_file_path, arcname=f'{base_filename}.tif')

		# Include both dataset columns and extracted v2_metadata fields in the bundle metadata.
		df = pd.DataFrame([build_single_dataset_metadata_row(dataset, ortho, metadata)])
		_write_metadata_tables(archive, df, include_parquet)
		_write_license_and_citation(archive, [dataset])

		if labels is not None:
			_write_label_geopackages(archive, dataset.id, labels)

	return target_path


def export_dataset_aois(aois: List[Dict], gpkg_file: str):
	"""Write the given AOIs to the 'aoi' layer of a GeoPackage"""
	if not aois:
		logger.info('No AOIs to export')
		return

	features = [
		{
			'type': 'Feature',
			'geometry': aoi['geometry'],
			'properties': {
				'dataset_id': aoi['dataset_id'],
				'image_quality': aoi.get('image_quality'),
				'notes': aoi.get('notes'),
				'is_whole_image': aoi.get('is_whole_image'),
				'aoi_id': aoi['id'],
				'source': aoi.get('source', 'manual'),
				'corrected_from_aoi_id': aoi.get('corrected_from_aoi_id'),
			},
		}
		for aoi in aois
	]
	aoi_gdf = gpd.GeoDataFrame.from_features(features)
	aoi_gdf.set_crs('EPSG:4326', inplace=True)
	aoi_gdf.to_file(gpkg_file, driver='GPKG', layer='aoi')
	logger.info(f'Added AOI layer with {len(features)} features to geopackage')


def create_consolidated_geopackage(dataset_id: int, scope: ExportScope, gpkg_file: Path) -> Path:
	"""Write a single GeoPackage with one layer per label type/source plus the AOI layer.

	Args:
		dataset_id: The dataset ID to export
		scope: The labels and AOIs the requesting user may read
		gpkg_file: Where to write the GeoPackage (must not exist yet)

	Raises:
		ValueError: If the user can read no exportable labels of the dataset
	"""
	if not scope.labels:
		raise ValueError(f'No labels found for dataset {dataset_id}')

	filtered_labels = get_exportable_labels(scope)
	if not filtered_labels:
		raise ValueError(
			f'No labels with target sources (model_prediction, visual_interpretation) found for dataset {dataset_id}'
		)

	logger.info(f'Processing {len(filtered_labels)} labels for dataset {dataset_id}')
	for label in filtered_labels:
		label_to_geopackage(str(gpkg_file), label)
	export_dataset_aois(scope.aois, str(gpkg_file))

	logger.info(f'Created consolidated geopackage for dataset {dataset_id} at {gpkg_file}')
	return gpkg_file
