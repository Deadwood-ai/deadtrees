import zipfile
import io
import json
import tempfile
from pathlib import Path

import geopandas as gpd
import yaml
import pandas as pd

from shared.models import Metadata, Label, Dataset, LicenseEnum

TEMPLATE_PATH = Path(__file__).parent / 'templates'


def label_to_geopackage(label_file, label: Label) -> io.BytesIO:
	# create a GeoDataFrame from the label
	label_gdf = gpd.GeoDataFrame.from_features(
		[
			{
				'type': 'Feature',
				'geometry': label.label.model_dump(),
				'properties': {'source': label.label_source, 'type': label.label_type, 'quality': label.label_quality},
			}
		]
	)
	label_gdf.set_crs('EPSG:4326', inplace=True)
	label_gdf.to_file(label_file, driver='GPKG', layer='labels')

	# create a layer for the aoi
	aoi_gdf = gpd.GeoDataFrame.from_features(
		[{'type': 'Feature', 'geometry': label.aoi.model_dump(), 'properties': {'dataset_id': label.dataset_id}}]
	)
	aoi_gdf.set_crs('EPSG:4326', inplace=True)
	aoi_gdf.to_file(label_file, driver='GPKG', layer='aoi')

	return label_file


def create_citation_file(metadata: Metadata, filestream=None) -> str:
	# load the template
	with open(TEMPLATE_PATH / 'CITATION.cff', 'r') as f:
		template = yaml.safe_load(f)

	# fill the template
	template['title'] = (
		f'Deadwood Training Dataset: {metadata.file_name}'  # TODO: replace this with the actual dataset name
	)

	# check if the authors can be split into first and last names
	author_list = []
	authors = metadata.authors.split(', ')
	for author in authors:
		author_list.append({'name': author})

	# add all authors defined in the template
	author_list = [*author_list, *template['authors']]

	# check if there is a DOI
	if metadata.citation_doi is not None:
		template['identifiers'] = [
			{'type': 'doi', 'value': metadata.citation_doi, 'description': 'The DOI of the original dataset.'}
		]

	# add the license
	template['license'] = f'{metadata.license.value}-4.0'.upper()

	# create a buffer to write to
	if filestream is None:
		filestream = io.StringIO()
	yaml.dump(template, filestream)

	return filestream


def get_formatted_filename(metadata: Metadata, dataset_id: int, label_id: int = None) -> str:
	"""Generate formatted filename with admin levels and date"""
	# Get admin levels (default to 'unknown' if not set)
	admin1 = metadata.admin_level_1 or 'unknown'
	admin3 = metadata.admin_level_3 or 'unknown'

	# Clean admin names (remove spaces and special chars)
	admin1 = ''.join(c for c in admin1 if c.isalnum())
	admin3 = ''.join(c for c in admin3 if c.isalnum())

	# Format date string
	date_str = f'{metadata.aquisition_year}'
	if metadata.aquisition_month:
		date_str += f'{metadata.aquisition_month:02d}'
	if metadata.aquisition_day:
		date_str += f'{metadata.aquisition_day:02d}'

	# Build base filename
	if label_id:
		return f'labels_{dataset_id}_{admin1}_{admin3}_{label_id}'
	else:
		return f'ortho_{dataset_id}_{admin1}_{admin3}_{date_str}'


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
	label: Label | None = None,
):
	"""Bundle dataset files into a ZIP archive"""
	# Generate formatted filename base
	base_filename = f'ortho_{dataset.id}'

	# Create the ZIP archive
	with zipfile.ZipFile(target_path, 'w', zipfile.ZIP_STORED) as archive:
		# Add the ortho file
		archive.write(archive_file_path, arcname=f'{base_filename}.tif')

		# Convert dataset to DataFrame for metadata
		df = pd.DataFrame([dataset.model_dump(exclude={'id', 'created_at'})])

		# Create temporary files for metadata formats
		with tempfile.NamedTemporaryFile(suffix='.csv') as csv_file, tempfile.NamedTemporaryFile(
			suffix='.parquet'
		) as parquet_file:
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

	# Add labels if present
	if label is not None:
		label_filename = f'labels_{dataset.id}'
		with tempfile.NamedTemporaryFile(suffix='.gpkg') as label_file:
			label_to_geopackage(label_file.name, label)

			with zipfile.ZipFile(target_path, 'a', zipfile.ZIP_STORED) as archive:
				archive.write(label_file.name, arcname=f'{label_filename}.gpkg')

	return target_path
