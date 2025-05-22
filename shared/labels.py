from typing import List, Dict, Any, Optional
from datetime import datetime

from shapely.geometry import shape, MultiPolygon, Polygon
from shapely import wkb

from shared.models import (
	LabelPayloadData,
	Label,
	AOI,
	DeadwoodGeometry,
	ForestCoverGeometry,
	LabelDataEnum,
	LabelSourceEnum,
)
from shared.db import use_client
from shared.settings import settings
from shared.logger import logger

MAX_CHUNK_SIZE = 1024 * 1024 * 5  # 5MB per chunk


def create_label_with_geometries(payload: LabelPayloadData, user_id: str, token: str) -> Label:
	"""Creates a label with associated AOI and geometries, handling large geometry uploads
	through chunking.
	"""

	aoi_id = None
	if payload.aoi_geometry or payload.aoi_is_whole_image:
		# Handle AOI creation/reuse
		aoi = AOI(
			dataset_id=payload.dataset_id,
			user_id=user_id,
			geometry=payload.aoi_geometry.model_dump(),  # Convert to GeoJSON dict
			is_whole_image=payload.aoi_is_whole_image,
			image_quality=payload.aoi_image_quality,
			notes=payload.aoi_notes,
		)

		with use_client(token) as client:
			# Check for existing whole-image AOI
			if payload.aoi_is_whole_image:
				response = (
					client.table(settings.aois_table)
					.select('id')
					.eq('dataset_id', payload.dataset_id)
					.eq('is_whole_image', True)
					.execute()
				)
				if response.data:
					aoi_id = response.data[0]['id']

			# Create new AOI if needed
			if not aoi_id:
				try:
					response = (
						client.table(settings.aois_table)
						.insert(aoi.model_dump(exclude={'id', 'created_at', 'updated_at'}))
						.execute()
					)
					aoi_id = response.data[0]['id']
				except Exception as e:
					logger.error(f'Error creating AOI: {str(e)}', extra={'token': token, 'user_id': user_id})
					raise Exception(f'Error creating AOI: {str(e)}')

	# Create label entry
	label = Label(
		dataset_id=payload.dataset_id,
		aoi_id=aoi_id,
		user_id=user_id,
		label_source=payload.label_source,
		label_type=payload.label_type,
		label_data=payload.label_data,
		label_quality=payload.label_quality,
	)

	# Start transaction for label and geometries
	with use_client(token) as client:
		try:
			# Insert label
			response = (
				client.table(settings.labels_table)
				.insert(label.model_dump(exclude={'id', 'created_at', 'updated_at'}))
				.execute()
			)
			label_id = response.data[0]['id']

			# Process geometries
			geom = shape(payload.geometry.model_dump())
			if not isinstance(geom, MultiPolygon):
				geom = MultiPolygon([geom])

			# Split MultiPolygon into individual polygons
			polygons = [poly for poly in geom.geoms]

			# Determine geometry table based on label_data
			geom_table = (
				settings.deadwood_geometries_table
				if payload.label_data == LabelDataEnum.deadwood
				else settings.forest_cover_geometries_table
			)

			GeometryModel = DeadwoodGeometry if payload.label_data == LabelDataEnum.deadwood else ForestCoverGeometry

			# Split geometries into chunks
			current_chunk_size = 0
			current_chunk = []

			for polygon in polygons:
				# Convert to WKB to estimate size
				wkb_geom = wkb.dumps(polygon)
				geom_size = len(wkb_geom)

				if current_chunk_size + geom_size > MAX_CHUNK_SIZE and current_chunk:
					# Upload current chunk
					upload_geometry_chunk(
						client, geom_table, GeometryModel, label_id, current_chunk, payload.properties, token
					)
					current_chunk = []
					current_chunk_size = 0

				current_chunk.append(polygon)
				current_chunk_size += geom_size

			# Upload remaining geometries
			if current_chunk:
				upload_geometry_chunk(
					client, geom_table, GeometryModel, label_id, current_chunk, payload.properties, token
				)

			return Label(**response.data[0])

		except Exception as e:
			logger.error(f'Error creating label: {str(e)}', extra={'token': token, 'user_id': user_id})
			raise Exception(f'Error creating label: {str(e)}')


def upload_geometry_chunk(
	client,
	table: str,
	GeometryModel: type[DeadwoodGeometry] | type[ForestCoverGeometry],
	label_id: int,
	geometries: List[Any],
	properties: Optional[Dict[str, Any]],
	token: str,
) -> None:
	"""Uploads a chunk of geometries to the database."""

	geometry_records = []
	for geom in geometries:
		# Convert the geometry to a single polygon
		if isinstance(geom, MultiPolygon):
			raise ValueError('Expected Polygon geometry, received MultiPolygon')

		# Ensure we're working with a valid polygon
		if not isinstance(geom, Polygon):
			raise ValueError(f'Expected Polygon geometry, received {type(geom)}')

		geometry = GeometryModel(label_id=label_id, geometry=geom.__geo_interface__, properties=properties)
		geometry_records.append(geometry.model_dump(exclude={'id', 'created_at'}))

	try:
		client.table(table).insert(geometry_records).execute()
	except Exception as e:
		logger.error(f'Error uploading geometry chunk: {str(e)}', extra={'token': token})
		raise Exception(f'Error uploading geometry chunk: {str(e)}')


def delete_model_prediction_labels(dataset_id: int, label_data: LabelDataEnum, token: str) -> int:
	"""Deletes all model prediction labels for a dataset with the specified label data type.

	Args:
		dataset_id: The ID of the dataset to delete labels for
		label_data: The label data type (e.g., deadwood, forest_cover)
		token: Authentication token

	Returns:
		int: Number of labels deleted
	"""
	deleted_count = 0

	with use_client(token) as client:
		try:
			# First, get all model prediction labels for this dataset with the specified label data type
			response = (
				client.table(settings.labels_table)
				.select('id')
				.eq('dataset_id', dataset_id)
				.eq('label_source', LabelSourceEnum.model_prediction.value)
				.eq('label_data', label_data.value)
				.execute()
			)

			if not response.data:
				# No existing labels found
				return 0

			# Get label IDs to delete
			label_ids = [label['id'] for label in response.data]
			deleted_count = len(label_ids)

			# Determine geometry table based on label_data
			# geom_table = (
			# 	settings.deadwood_geometries_table
			# 	if label_data == LabelDataEnum.deadwood
			# 	else settings.forest_cover_geometries_table
			# )

			# Delete all geometries for these labels
			# Note: This isn't strictly necessary due to ON DELETE CASCADE, but being explicit
			# for label_id in label_ids:
			# client.table(geom_table).delete().eq('label_id', label_id).execute()

			# Delete the labels themselves
			client.table(settings.labels_table).delete().in_('id', label_ids).execute()

			logger.info(f'Deleted {deleted_count} existing model prediction labels for dataset {dataset_id}')
			return deleted_count

		except Exception as e:
			logger.error(
				f'Error deleting model prediction labels: {str(e)}', extra={'token': token, 'dataset_id': dataset_id}
			)
			raise Exception(f'Error deleting model prediction labels: {str(e)}')
