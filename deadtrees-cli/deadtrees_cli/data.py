from pathlib import Path
from typing import Optional, List, Dict, Any, Union
import time
import httpx
from tqdm import tqdm
import uuid
import geopandas as gpd
from shapely.geometry import MultiPolygon

from shared.db import login, verify_token, use_client
from shared.settings import settings
from shared.models import (
	Dataset,
	TaskTypeEnum,
	PlatformEnum,
	DatasetAccessEnum,
	Label,
	LabelDataEnum,
	LicenseEnum,
	LabelSourceEnum,
	LabelTypeEnum,
	LabelPayloadData,
	AOI,
)
from shared.labels import create_label_with_geometries
from shared.logger import logger


class DataCommands:
	"""Data operations for the Deadwood API"""

	def __init__(self):
		self._token = None
		self._client = None

	def _ensure_auth(self):
		"""Ensure we have a valid authentication token"""
		if not self._token:
			self._token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
			if not verify_token(self._token):
				try:
					self._token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
				except Exception as e:
					raise ValueError('Authentication failed')
		return self._token

	def upload(
		self,
		file_path: str,
		authors: List[str],
		platform: str = 'drone',
		data_access: str = 'public',
		license: str = 'CC BY',
		aquisition_year: Optional[int] = None,
		aquisition_month: Optional[int] = None,
		aquisition_day: Optional[int] = None,
		additional_information: Optional[str] = None,
		citation_doi: Optional[str] = None,
	):
		"""Upload a dataset to the API"""
		token = self._ensure_auth()
		file_path = Path(file_path)

		# Validate and convert enums
		try:
			platform_enum = PlatformEnum(platform)
			access_enum = DatasetAccessEnum(data_access)
			license_enum = LicenseEnum(license)
		except ValueError as e:
			raise ValueError(f'Invalid enum value: {str(e)}')

		# Start upload process
		logger.info(f'Uploading file: {file_path}')
		dataset = self._chunked_upload(
			file_path=file_path,
			token=token,
			license=license_enum,
			platform=platform_enum,
			authors=authors,
			data_access=access_enum,
			aquisition_year=aquisition_year,
			aquisition_month=aquisition_month,
			aquisition_day=aquisition_day,
			additional_information=additional_information,
			citation_doi=citation_doi,
		)

		return dataset

	def _chunked_upload(
		self,
		file_path: Path,
		token: str,
		chunk_size: int = 100 * 1024 * 1024,  # 100MB chunks
		**metadata,
	):
		"""Upload a file in chunks with progress bar"""
		file_size = file_path.stat().st_size
		chunks_total = (file_size + chunk_size - 1) // chunk_size
		upload_id = str(uuid.uuid4())

		progress = tqdm(total=file_size, unit='B', unit_scale=True, desc=f'Uploading {file_path.name}')
		logger.info(f'Uploading file: {file_path}, to endpoint: {settings.API_ENDPOINT}')

		with open(file_path, 'rb') as f, httpx.Client(timeout=httpx.Timeout(timeout=300.0)) as client:
			for chunk_index in range(chunks_total):
				chunk_data = f.read(chunk_size)

				# Required form fields
				form_data = {
					'chunk_index': str(chunk_index),
					'chunks_total': str(chunks_total),
					'upload_id': upload_id,
					'license': metadata['license'].value,
					'platform': metadata['platform'].value,
					'authors': metadata['authors'],
					'data_access': metadata['data_access'].value,
				}

				# Optional form fields
				optional_fields = [
					'project_id',
					'aquisition_year',
					'aquisition_month',
					'aquisition_day',
					'additional_information',
					'citation_doi',
				]

				# Add optional fields if they exist in metadata
				for field in optional_fields:
					if field in metadata and metadata[field] is not None:
						form_data[field] = str(metadata[field])

				files = {'file': (file_path.name, chunk_data, 'application/octet-stream')}

				try:
					response = client.post(
						settings.API_ENTPOINT_DATASETS,
						files=files,
						data=form_data,
						headers={'Authorization': f'Bearer {token}'},
					)
					response.raise_for_status()
					progress.update(len(chunk_data))

					if chunk_index == chunks_total - 1:
						progress.close()
						return response.json()

				except Exception as e:
					progress.close()
					logger.error(f'Error uploading chunk {chunk_index}: {e}')
					raise

	def process(self, dataset_id: int, task_types: Optional[List[str]] = None, priority: Optional[int] = 2):
		"""
		Start processing tasks for a dataset

		Args:
			dataset_id: ID of the dataset to process
			task_types: List of task types to process. Defaults to ['cog', 'thumbnail']
			priority: Task priority (1=highest, 5=lowest). Defaults to 2.
		"""
		token = self._ensure_auth()

		# Default task types if none provided
		if not task_types:
			task_types = ['cog', 'thumbnail']

		# Validate task types
		try:
			validated_task_types = [TaskTypeEnum(t).value for t in task_types]
		except ValueError as e:
			raise ValueError(f'Invalid task type: {str(e)}')

		# Validate priority
		if priority < 1 or priority > 5:
			raise ValueError('Priority must be between 1 (highest) and 5 (lowest)')

		logger.info(
			f'Starting processing for dataset {dataset_id} with tasks: {validated_task_types}, priority: {priority}'
		)

		try:
			with httpx.Client() as client:
				response = client.put(
					f'{settings.API_ENDPOINT}/datasets/{dataset_id}/process',
					json={'task_types': validated_task_types, 'priority': priority},
					headers={'Authorization': f'Bearer {token}'},
				)
				response.raise_for_status()

				data = response.json()
				logger.info(f'Processing started: {data}')
				return data

		except httpx.HTTPStatusError as e:
			if e.response.status_code == 404:
				raise ValueError(f'Dataset {dataset_id} not found')
			elif e.response.status_code == 401:
				raise ValueError('Authentication failed')
			else:
				logger.error(f'Error starting processing: {str(e)}')
				raise ValueError(f'Error starting processing: {str(e)}')
		except Exception as e:
			logger.error(f'Unexpected error starting processing: {str(e)}')
			raise

	def upload_label(
		self,
		dataset_id: int,
		labels_gdf: gpd.GeoDataFrame,
		label_source: str,
		label_type: str,
		label_data: str,
		label_quality: int,
		properties: Optional[Dict[str, Any]] = None,
		aoi_gdf: Optional[gpd.GeoDataFrame] = None,
		aoi_image_quality: Optional[int] = None,
		aoi_notes: Optional[str] = None,
	) -> Label:
		"""Upload a label to an existing dataset

		Args:
			dataset_id: ID of the dataset
			labels_gdf: GeoDataFrame containing the label geometries
			label_source: Source of the label (e.g., 'visual_interpretation', 'model_prediction')
			label_type: Type of label (e.g., 'segmentation')
			label_data: Type of data (e.g., 'deadwood', 'forest_cover')
			label_quality: Quality score (1-3)
			properties: Additional properties to store with the geometries
			aoi_gdf: Optional GeoDataFrame containing the AOI geometry
			aoi_image_quality: Quality score for the AOI image (1-3)
			aoi_notes: Additional notes for the AOI
		"""
		token = self._ensure_auth()

		# Filter out rows with empty or null geometries
		valid_labels_gdf = labels_gdf[~labels_gdf.geometry.isna()]

		if valid_labels_gdf.empty:
			logger.warning('No valid geometries found in labels GeoDataFrame')
			return None

		# Convert labels to MultiPolygon GeoJSON
		labels_geojson = {
			'type': 'MultiPolygon',
			'coordinates': [
				[[[float(coord[0]), float(coord[1])] for coord in polygon.exterior.coords]]
				for geom in valid_labels_gdf.geometry
				for polygon in (geom.geoms if isinstance(geom, MultiPolygon) else [geom])
				if geom is not None  # Additional check for None geometries
			],
		}

		# Prepare AOI if provided
		aoi_geojson = None
		if aoi_gdf is not None and not aoi_gdf.empty:
			valid_aoi_gdf = aoi_gdf[~aoi_gdf.geometry.isna()]
			if not valid_aoi_gdf.empty:
				aoi_geojson = {
					'type': 'MultiPolygon',
					'coordinates': [
						[[[float(coord[0]), float(coord[1])] for coord in poly.exterior.coords]]
						for geom in valid_aoi_gdf.geometry
						for poly in (geom.geoms if isinstance(geom, MultiPolygon) else [geom])
						if geom is not None  # Additional check for None geometries
					],
				}

		# Create label payload
		payload = LabelPayloadData(
			dataset_id=dataset_id,
			label_source=LabelSourceEnum(label_source),
			label_type=LabelTypeEnum(label_type),
			label_data=LabelDataEnum(label_data),
			label_quality=label_quality,
			geometry=labels_geojson,
			properties=properties,
			aoi_geometry=aoi_geojson,
			aoi_image_quality=aoi_image_quality,
			aoi_notes=aoi_notes,
		)

		# Get user ID from token
		user = verify_token(token)
		if not user:
			raise ValueError('Invalid token')

		# Create label with geometries
		return create_label_with_geometries(payload, user.id, token)

	def upload_label_from_gpkg(
		self,
		dataset_id: int,
		gpkg_path: Union[str, Path],
		label_source: str,
		label_type: str,
		label_data: str,
		label_quality: int,
		properties: Optional[Dict[str, Any]] = None,
		labels_layer: str = 'labels',
		aoi_layer: Optional[str] = 'aoi',
		aoi_image_quality: Optional[int] = None,
		aoi_notes: Optional[str] = None,
	) -> Label:
		"""Upload a label from a GeoPackage file"""
		# Read labels layer
		labels_gdf = gpd.read_file(gpkg_path, layer=labels_layer).to_crs(epsg=4326)

		# Read AOI layer if specified
		aoi_gdf = None
		if aoi_layer:
			try:
				aoi_gdf = gpd.read_file(gpkg_path, layer=aoi_layer).to_crs(epsg=4326)
			except Exception:
				logger.warning(f'AOI layer "{aoi_layer}" not found in GeoPackage')

		return self.upload_label(
			dataset_id=dataset_id,
			labels_gdf=labels_gdf,
			label_source=label_source,
			label_type=label_type,
			label_data=label_data,
			label_quality=label_quality,
			properties=properties,
			aoi_gdf=aoi_gdf,
			aoi_image_quality=aoi_image_quality,
			aoi_notes=aoi_notes,
		)

	def upload_aoi_from_gpkg(
		self,
		dataset_id: int,
		gpkg_path: Union[str, Path],
		aoi_layer: str = 'aoi',
		aoi_image_quality: Optional[int] = None,
		aoi_notes: Optional[str] = None,
	) -> Optional[AOI]:
		"""Upload only an AOI from a GeoPackage file

		Args:
			dataset_id: ID of the dataset
			gpkg_path: Path to the GeoPackage file
			aoi_layer: Name of the AOI layer in the GeoPackage
			aoi_image_quality: Quality score for the AOI image (1-3)
			aoi_notes: Additional notes for the AOI
		"""
		token = self._ensure_auth()

		# Read AOI layer
		try:
			aoi_gdf = gpd.read_file(gpkg_path, layer=aoi_layer).to_crs(epsg=4326)
		except Exception as e:
			logger.warning(f'Error reading AOI layer "{aoi_layer}": {str(e)}')
			return None

		if aoi_gdf.empty:
			logger.warning(f'AOI layer "{aoi_layer}" is empty')
			return None

		# Convert AOI to MultiPolygon GeoJSON
		aoi_geojson = {
			'type': 'MultiPolygon',
			'coordinates': [
				[[[float(coord[0]), float(coord[1])] for coord in polygon.exterior.coords]]
				for geom in aoi_gdf.geometry
				for polygon in (geom.geoms if isinstance(geom, MultiPolygon) else [geom])
				if geom is not None  # Additional check for None geometries
			],
		}

		# Get user ID from token
		user = verify_token(token)
		if not user:
			raise ValueError('Invalid token')

		# Create AOI object
		aoi = AOI(
			dataset_id=dataset_id,
			user_id=user.id,
			geometry=aoi_geojson,
			image_quality=aoi_image_quality,
			notes=aoi_notes,
		)

		# Save to database
		with use_client(token) as client:
			try:
				response = (
					client.table(settings.aois_table)
					.insert(aoi.model_dump(exclude={'id', 'created_at', 'updated_at'}))
					.execute()
				)
				if response.data:
					aoi.id = response.data[0]['id']
					return aoi
			except Exception as e:
				logger.error(f'Error creating AOI: {str(e)}')
				raise

		return None
