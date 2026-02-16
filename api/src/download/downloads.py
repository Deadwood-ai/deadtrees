import zipfile
import io
import json
import hashlib
import tempfile
from pathlib import Path
from typing import List, Dict, Optional, Tuple, Set

import geopandas as gpd
import yaml
import pandas as pd

from shared.logging import UnifiedLogger, LogCategory, LogContext
from shared.settings import settings
from shared.db import use_client
from shared.models import Label, Dataset, LicenseEnum, Ortho, LabelDataEnum, LabelSourceEnum

TEMPLATE_PATH = Path(__file__).parent / 'templates'

# Base URL for deadtrees dataset links
DEADTREES_BASE_URL = 'https://deadtrees.earth/datasets'

# Create a proper logger
logger = UnifiedLogger(__name__)


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
	# Extract admin levels from metadata
	admin_levels = {}
	if metadata and 'metadata' in metadata:
		gadm = metadata['metadata'].get('gadm', {})
		admin_levels = {
			'admin_level_0': gadm.get('admin_level_1'),  # Country (GADM naming is off-by-one)
			'admin_level_1': gadm.get('admin_level_1'),
			'admin_level_2': gadm.get('admin_level_2'),
			'admin_level_3': gadm.get('admin_level_3'),
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
		'centroid_lat': centroid_lat,
		'centroid_lon': centroid_lon,
		'additional_information': dataset.additional_information,
	}


def generate_bundle_job_id(dataset_ids: List[int], include_labels: bool, include_parquet: bool) -> str:
	"""
	Generate a deterministic job ID for a multi-dataset bundle.
	
	Args:
		dataset_ids: List of dataset IDs to bundle
		include_labels: Whether labels are included
		include_parquet: Whether parquet is included
		
	Returns:
		A short hash string suitable for use as job_id and filename
	"""
	# Sort IDs for deterministic hash
	sorted_ids = sorted(dataset_ids)
	key = f"{sorted_ids}-{include_labels}-{include_parquet}"
	return hashlib.sha256(key.encode()).hexdigest()[:12]


def bundle_multi_dataset(
	target_path: str,
	datasets_info: List[Tuple[Dataset, Dict, Optional[Dict], str]],
	include_labels: bool = False,
	include_parquet: bool = False,
	use_original_filename: bool = True,
) -> str:
	"""
	Bundle multiple datasets into a single ZIP archive.
	
	Args:
		target_path: Path to write the ZIP file
		datasets_info: List of tuples (dataset, ortho_dict, metadata_dict, archive_file_path)
		include_labels: Whether to include label GeoPackages
		include_parquet: Whether to include METADATA.parquet
		use_original_filename: If True, use original filenames for orthos; if False, use ortho_{id}.tif
		
	Returns:
		Path to the created ZIP file
	"""
	if not datasets_info:
		raise ValueError("No datasets provided for bundling")
	
	# Track used filenames to handle collisions
	used_names: Set[str] = set()
	
	# Build metadata rows for all datasets
	metadata_rows = []
	ortho_entries = []  # (archive_name, file_path)
	
	for dataset, ortho, metadata, archive_file_path in datasets_info:
		# Get base filename and resolve collisions
		base_name = get_ortho_base_filename(dataset, use_original_filename)
		unique_name = get_unique_archive_name(base_name, used_names)
		used_names.add(unique_name)
		
		ortho_entries.append((unique_name, archive_file_path))
		
		# Build metadata row
		row = build_dataset_metadata_row(dataset, ortho, metadata)
		row['bundle_filename'] = unique_name  # Track which file in bundle
		metadata_rows.append(row)
	
	# Get first dataset for license/citation (assume same license for all)
	first_dataset = datasets_info[0][0]
	
	# Create the ZIP archive
	with zipfile.ZipFile(target_path, 'w', zipfile.ZIP_STORED) as archive:
		# Add all ortho files
		for archive_name, file_path in ortho_entries:
			if Path(file_path).exists():
				archive.write(file_path, arcname=archive_name)
				logger.info(f"Added {archive_name} to multi-dataset bundle")
			else:
				logger.warning(f"Ortho file not found: {file_path}")
		
		# Create consolidated metadata DataFrame
		df = pd.DataFrame(metadata_rows)
		
		# Write METADATA.csv
		with tempfile.NamedTemporaryFile(suffix='.csv', delete=False) as csv_file:
			df.to_csv(csv_file.name, index=False)
			archive.write(csv_file.name, arcname='METADATA.csv')
			Path(csv_file.name).unlink()
		
		# Write METADATA.parquet if requested
		if include_parquet:
			with tempfile.NamedTemporaryFile(suffix='.parquet', delete=False) as parquet_file:
				df.to_parquet(parquet_file.name, index=False)
				archive.write(parquet_file.name, arcname='METADATA.parquet')
				Path(parquet_file.name).unlink()
		
		# Add license file
		license_content = create_license_file(first_dataset.license)
		archive.writestr('LICENSE.txt', license_content)
		
		# Add citation file
		citation_buffer = io.StringIO()
		create_citation_file(first_dataset, citation_buffer)
		archive.writestr('CITATION.cff', citation_buffer.getvalue())
		
		# Add labels if requested
		if include_labels:
			with tempfile.TemporaryDirectory() as temp_dir:
				for dataset, ortho, metadata, archive_file_path in datasets_info:
					# Get all labels for this dataset
					labels = get_all_dataset_labels(dataset.id)
					
					if not labels:
						continue
					
					# Process each type of label
					for label_type in set(label.label_data for label in labels):
						# Create temporary file for this label type
						label_file = Path(temp_dir) / f'{label_type.value}_{dataset.id}.gpkg'
						
						# Filter labels of this type
						type_labels = [label for label in labels if label.label_data == label_type]
						
						# Process each label into the GeoPackage
						for label in type_labels:
							label_to_geopackage(str(label_file), label)
						
						# Add unified AOI layer to the GeoPackage
						export_dataset_aois(dataset.id, str(label_file))
						
						# Add to archive with ID-based name (always use ID for labels)
						archive_name = f'labels_{label_type.value}_{dataset.id}.gpkg'
						if label_file.exists():
							archive.write(label_file, arcname=archive_name)
							logger.info(f"Added {archive_name} to multi-dataset bundle")
	
	logger.info(f"Created multi-dataset bundle with {len(datasets_info)} datasets at {target_path}")
	return target_path


def label_to_geopackage(label_file, label: Label) -> io.BytesIO:
	"""Convert a single label to GeoPackage format"""
	# Get geometries from the database
	with use_client() as client:
		if label.label_data == LabelDataEnum.deadwood:
			geom_table = settings.deadwood_geometries_table
		else:
			geom_table = settings.forest_cover_geometries_table

		# Get geometries for this label using pagination to handle large datasets
		all_geometries = []
		batch_size = 5000  # Optimized batch size: ~7MB per batch for typical geometries (~1.4KB each)
		offset = 0

		while True:
			# Fetch geometries in batches
			geom_response = (
				client.table(geom_table)
				.select('*')
				.eq('label_id', label.id)
				.eq('is_deleted', False)
				.range(offset, offset + batch_size - 1)
				.execute()
			)

			if not geom_response.data:
				break

			all_geometries.extend(geom_response.data)

			# If we got fewer than batch_size results, we've reached the end
			if len(geom_response.data) < batch_size:
				break

			offset += batch_size

			# Log progress for large datasets
			if len(all_geometries) % 10000 == 0:
				logger.info(f'Fetched {len(all_geometries)} geometries for label {label.id}')

		if not all_geometries:
			raise ValueError(f'No geometries found for label {label.id}')

		logger.info(f'Successfully fetched {len(all_geometries)} geometries for label {label.id}')

		# Create features from geometries
		features = []
		for geom in all_geometries:
			# Get properties with a default empty dict and filter out None values
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

		# Create GeoDataFrame
		label_gdf = gpd.GeoDataFrame.from_features(features)
		label_gdf.set_crs('EPSG:4326', inplace=True)

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

		# If layer exists, read existing data and append the new data
		if layer_name in existing_layers:
			# Read existing layer
			existing_gdf = gpd.read_file(label_file, layer=layer_name)
			# Append new data
			combined_gdf = pd.concat([existing_gdf, label_gdf], ignore_index=True)
			# Write back combined data, overwriting the layer
			combined_gdf.to_file(label_file, driver='GPKG', layer=layer_name)
		else:
			# Write to a new layer
			label_gdf.to_file(label_file, driver='GPKG', layer=layer_name)

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


def get_all_dataset_labels(dataset_id: int) -> List[Label]:
	"""Get all labels for a dataset using pagination"""
	with use_client() as client:
		all_labels = []
		batch_size = 300  # Conservative batch size to avoid memory issues
		offset = 0

		while True:
			# Fetch labels in batches
			label_response = (
				client.table(settings.labels_table)
				.select('*')
				.eq('dataset_id', dataset_id)
				.range(offset, offset + batch_size - 1)
				.execute()
			)

			if not label_response.data:
				break

			all_labels.extend(label_response.data)

			# If we got fewer than batch_size results, we've reached the end
			if len(label_response.data) < batch_size:
				break

			offset += batch_size

		if not all_labels:
			return []

		logger.info(f'Successfully fetched {len(all_labels)} labels for dataset {dataset_id}')
		return [Label(**label_data) for label_data in all_labels]


def create_labels_geopackages(dataset_id: int) -> Dict[str, Path]:
	"""Create GeoPackage files for all labels of a dataset, grouped by label type"""
	labels = get_all_dataset_labels(dataset_id)
	if not labels:
		return {}

	# Group labels by label_data type
	label_files = {}
	with tempfile.TemporaryDirectory() as temp_dir:
		# Create a separate GeoPackage for each label type
		for label_type in set(label.label_data for label in labels):
			type_labels = [label for label in labels if label.label_data == label_type]

			# Skip if no labels of this type
			if not type_labels:
				continue

			gpkg_path = Path(temp_dir) / f'{label_type.value}_{dataset_id}.gpkg'

			# Process each label into the same GeoPackage but different layers
			for label in type_labels:
				label_to_geopackage(str(gpkg_path), label)

			# Store the file path for later use
			label_files[label_type] = gpkg_path

	return label_files


def create_citation_file(dataset: Dataset, filestream=None) -> str:
	# load the template
	with open(TEMPLATE_PATH / 'CITATION.cff', 'r') as f:
		template = yaml.safe_load(f)

	# fill the template
	template['title'] = f'Deadwood Training Dataset: {dataset.file_name}'

	# check if the authors can be split into first and last names
	author_list = []
	for author in dataset.authors:
		author_list.append({'name': author})

	# add all authors defined in the template
	author_list = [*author_list, *template['authors']]

	# check if there is a DOI
	if dataset.citation_doi is not None:
		template['identifiers'] = [
			{'type': 'doi', 'value': dataset.citation_doi, 'description': 'The DOI of the original dataset.'}
		]

	# add the license
	template['license'] = f'{dataset.license.value}-4.0'.upper()

	# create a buffer to write to
	if filestream is None:
		filestream = io.StringIO()
	yaml.dump(template, filestream)

	return filestream


def get_formatted_filename(dataset: Dataset, ortho: Ortho, label_id: int = None) -> str:
	"""Generate formatted filename with admin levels and date"""
	# Get admin levels from metadata (default to 'unknown' if not set)
	admin1 = ortho.admin_level_1 or 'unknown'
	admin3 = ortho.admin_level_3 or 'unknown'

	# Clean admin names (remove spaces and special chars)
	admin1 = ''.join(c for c in admin1 if c.isalnum())
	admin3 = ''.join(c for c in admin3 if c.isalnum())

	# Format date string
	date_str = f'{dataset.aquisition_year}'
	if dataset.aquisition_month:
		date_str += f'{dataset.aquisition_month:02d}'
	if dataset.aquisition_day:
		date_str += f'{dataset.aquisition_day:02d}'

	# Build base filename
	if label_id:
		return f'labels_{dataset.id}_{admin1}_{admin3}_{label_id}'
	else:
		return f'ortho_{dataset.id}_{admin1}_{admin3}_{date_str}'


def create_license_file(license_enum: LicenseEnum) -> str:
	"""Create license file content based on the license type"""
	license_file = TEMPLATE_PATH / f'{license_enum.value.replace(" ", "-")}.txt'
	if not license_file.exists():
		raise ValueError(f'License template file not found for {license_enum.value}')

	with open(license_file, 'r') as f:
		return f.read()


def bundle_variant_suffix(include_labels: bool, include_parquet: bool) -> str:
	parts = []
	if not include_labels:
		parts.append('nolabels')
	if not include_parquet:
		parts.append('noparquet')
	return '_'.join(parts)


def get_bundle_filename(dataset_id: int, include_labels: bool, include_parquet: bool) -> str:
	suffix = bundle_variant_suffix(include_labels, include_parquet)
	if not suffix:
		return f'{dataset_id}.zip'
	return f'{dataset_id}_{suffix}.zip'


def bundle_dataset(
	target_path: str,
	archive_file_path: str,
	dataset: Dataset,
	include_parquet: bool = True,
	include_labels: bool = True,
	use_original_filename: bool = False,
):
	"""Bundle dataset files into a ZIP archive including all labels"""
	# Generate formatted filename base
	base_filename = f'ortho_{dataset.id}'
	if use_original_filename and dataset.file_name:
		stem = Path(dataset.file_name).stem.strip()
		if stem:
			base_filename = stem

	# Create the ZIP archive
	with zipfile.ZipFile(target_path, 'w', zipfile.ZIP_STORED) as archive:
		# Add the ortho file
		archive.write(archive_file_path, arcname=f'{base_filename}.tif')

		# Convert dataset to DataFrame for metadata
		df = pd.DataFrame([dataset.model_dump(exclude={'id', 'created_at'})])

		# Create temporary files for metadata formats
		with tempfile.NamedTemporaryFile(suffix='.csv') as csv_file:
			df.to_csv(csv_file.name, index=False)
			archive.write(csv_file.name, arcname='METADATA.csv')

		if include_parquet:
			with tempfile.NamedTemporaryFile(suffix='.parquet') as parquet_file:
				df.to_parquet(parquet_file.name, index=False)
				archive.write(parquet_file.name, arcname='METADATA.parquet')

		# Add license file
		license_content = create_license_file(dataset.license)
		archive.writestr('LICENSE.txt', license_content)

		# Add citation file
		citation_buffer = io.StringIO()
		create_citation_file(dataset, citation_buffer)
		archive.writestr('CITATION.cff', citation_buffer.getvalue())

		if include_labels:
			# Get and add all labels
			with tempfile.TemporaryDirectory() as temp_dir:
				# Get all labels for this dataset
				labels = get_all_dataset_labels(dataset.id)

				if labels:
					# Process each type of label
					for label_type in set(label.label_data for label in labels):
						# Create temporary file for this label type
						label_file = Path(temp_dir) / f'{label_type.value}_{dataset.id}.gpkg'

						# Filter labels of this type
						type_labels = [label for label in labels if label.label_data == label_type]

						# Process each label into the GeoPackage
						for label in type_labels:
							label_to_geopackage(str(label_file), label)

						# Add unified AOI layer to the GeoPackage
						export_dataset_aois(dataset.id, str(label_file))

						# Add to archive with appropriate name
						archive_name = f'labels_{label_type.value}_{dataset.id}.gpkg'
						archive.write(label_file, arcname=archive_name)

						# Use logger without context if needed
						logger.info(f'Added {label_type.value} labels to bundle for dataset {dataset.id}')

	return target_path


def export_dataset_aois(dataset_id: int, gpkg_file: str):
	"""Export all AOIs for a dataset to 'aoi' layer in geopackage"""

	# Use default client (no user token needed for public datasets)
	with use_client() as client:
		# Query all AOIs for dataset using pagination if needed
		all_aois = []
		batch_size = 300  # Conservative batch size to avoid memory issues
		offset = 0

		while True:
			# Fetch AOIs in batches
			aoi_response = (
				client.table(settings.aois_table)
				.select('*')
				.eq('dataset_id', dataset_id)
				.range(offset, offset + batch_size - 1)
				.execute()
			)

			if not aoi_response.data:
				break

			all_aois.extend(aoi_response.data)

			# If we got fewer than batch_size results, we've reached the end
			if len(aoi_response.data) < batch_size:
				break

			offset += batch_size

		if not all_aois:
			logger.info(f'No AOIs found for dataset {dataset_id}')
			return  # No AOIs to export

		logger.info(f'Successfully fetched {len(all_aois)} AOIs for dataset {dataset_id}')

		# Create features from AOI data
		features = []
		for aoi in all_aois:
			features.append(
				{
					'type': 'Feature',
					'geometry': aoi['geometry'],
					'properties': {
						'dataset_id': aoi['dataset_id'],
						'image_quality': aoi.get('image_quality'),
						'notes': aoi.get('notes'),
						'is_whole_image': aoi.get('is_whole_image'),
						'aoi_id': aoi['id'],
					},
				}
			)

		# Create GeoDataFrame from AOI data
		aoi_gdf = gpd.GeoDataFrame.from_features(features)
		aoi_gdf.set_crs('EPSG:4326', inplace=True)

		# Check if file already exists to determine existing layers
		path = Path(gpkg_file)
		existing_layers = []
		if path.exists():
			try:
				import fiona

				existing_layers = fiona.listlayers(gpkg_file)
			except Exception:
				# File might exist but not be a valid GeoPackage yet
				pass

		# Write to 'aoi' layer in geopackage
		aoi_gdf.to_file(gpkg_file, driver='GPKG', layer='aoi')
		logger.info(f'Added AOI layer with {len(features)} features to geopackage')


def create_consolidated_geopackage(dataset_id: int) -> Path:
	"""Create single GeoPackage with multiple layers for a dataset

	Args:
		dataset_id: The dataset ID to export

	Returns:
		Path to the created GeoPackage file

	Raises:
		ValueError: If no labels found for dataset
	"""
	# Get all labels for the dataset
	all_labels = get_all_dataset_labels(dataset_id)

	if not all_labels:
		raise ValueError(f'No labels found for dataset {dataset_id}')

	# Filter labels to only include model_prediction and visual_interpretation sources
	target_sources = [LabelSourceEnum.model_prediction, LabelSourceEnum.visual_interpretation]
	filtered_labels = [label for label in all_labels if label.label_source in target_sources]

	if not filtered_labels:
		raise ValueError(
			f'No labels with target sources (model_prediction, visual_interpretation) found for dataset {dataset_id}'
		)

	logger.info(f'Processing {len(filtered_labels)} labels for dataset {dataset_id}')

	# Create temporary geopackage file
	temp_dir = tempfile.mkdtemp()
	gpkg_file = Path(temp_dir) / f'dataset_{dataset_id}_labels.gpkg'

	# Process each label using existing logic
	for label in filtered_labels:
		# No user_token needed for public datasets
		label_to_geopackage(str(gpkg_file), label)

	# Add unified AOI layer
	export_dataset_aois(dataset_id, str(gpkg_file))

	logger.info(f'Created consolidated geopackage for dataset {dataset_id} at {gpkg_file}')
	return gpkg_file
