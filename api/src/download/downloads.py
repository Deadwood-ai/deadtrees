import zipfile
import io
import json
import tempfile
from pathlib import Path
from typing import List, Dict, Optional

import geopandas as gpd
import yaml
import pandas as pd

from shared.logging import UnifiedLogger, LogCategory, LogContext
from shared.settings import settings
from shared.db import use_client
from shared.models import Label, Dataset, LicenseEnum, Ortho, LabelDataEnum, LabelSourceEnum

TEMPLATE_PATH = Path(__file__).parent / 'templates'

# Create a proper logger
logger = UnifiedLogger(__name__)


def label_to_geopackage(label_file, label: Label, user_token: Optional[str] = None) -> io.BytesIO:
	"""Convert a single label to GeoPackage format"""
	# Get geometries from the database
	client_context = use_client(user_token) if user_token else use_client()
	with client_context as client:
		if label.label_data == LabelDataEnum.deadwood:
			geom_table = settings.deadwood_geometries_table
		else:
			geom_table = settings.forest_cover_geometries_table

		# Get geometries for this label using pagination to handle large datasets
		all_geometries = []
		batch_size = 800  # Conservative batch size to avoid memory issues with large geometries
		offset = 0

		while True:
			# Fetch geometries in batches
			geom_response = (
				client.table(geom_table)
				.select('*')
				.eq('label_id', label.id)
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
			if len(all_geometries) % 5000 == 0:
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


def get_all_dataset_labels(dataset_id: int, user_token: Optional[str] = None) -> List[Label]:
	"""Get all labels for a dataset using pagination"""
	client_context = use_client(user_token) if user_token else use_client()
	with client_context as client:
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


def bundle_dataset(
	target_path: str,
	archive_file_path: str,
	dataset: Dataset,
):
	"""Bundle dataset files into a ZIP archive including all labels"""
	# Generate formatted filename base
	base_filename = f'ortho_{dataset.id}'

	# Create the ZIP archive
	with zipfile.ZipFile(target_path, 'w', zipfile.ZIP_STORED) as archive:
		# Add the ortho file
		archive.write(archive_file_path, arcname=f'{base_filename}.tif')

		# Convert dataset to DataFrame for metadata
		df = pd.DataFrame([dataset.model_dump(exclude={'id', 'created_at'})])

		# Create temporary files for metadata formats
		with (
			tempfile.NamedTemporaryFile(suffix='.csv') as csv_file,
			tempfile.NamedTemporaryFile(suffix='.parquet') as parquet_file,
		):
			df.to_csv(csv_file.name, index=False)
			df.to_parquet(parquet_file.name, index=False)

			archive.write(csv_file.name, arcname='METADATA.csv')
			archive.write(parquet_file.name, arcname='METADATA.parquet')

		# Add license file
		license_content = create_license_file(dataset.license)
		archive.writestr('LICENSE.txt', license_content)

		# Add citation file
		citation_buffer = io.StringIO()
		create_citation_file(dataset, citation_buffer)
		archive.writestr('CITATION.cff', citation_buffer.getvalue())

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

					# Add to archive with appropriate name
					archive_name = f'labels_{label_type.value}_{dataset.id}.gpkg'
					archive.write(label_file, arcname=archive_name)

					# Use logger without context if needed
					logger.info(f'Added {label_type.value} labels to bundle for dataset {dataset.id}')

	return target_path


def export_dataset_aois(dataset_id: int, gpkg_file: str, user_token: Optional[str] = None):
	"""Export all AOIs for a dataset to 'aoi' layer in geopackage"""

	# Use appropriate client based on whether we have a user token
	client_context = use_client(user_token) if user_token else use_client()

	with client_context as client:
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


def create_consolidated_geopackage(dataset_id: int, user_token: Optional[str] = None) -> Path:
	"""Create single GeoPackage with multiple layers for a dataset

	Args:
		dataset_id: The dataset ID to export
		user_token: Optional user token for private dataset access

	Returns:
		Path to the created GeoPackage file

	Raises:
		ValueError: If no labels found for dataset
	"""
	# Get all labels for the dataset
	all_labels = get_all_dataset_labels(dataset_id, user_token)

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
		# Pass user_token to label_to_geopackage for proper authentication
		label_to_geopackage(str(gpkg_file), label, user_token)

	# Add unified AOI layer
	export_dataset_aois(dataset_id, str(gpkg_file), user_token)

	logger.info(f'Created consolidated geopackage for dataset {dataset_id} at {gpkg_file}')
	return gpkg_file
