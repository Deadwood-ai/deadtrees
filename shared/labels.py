from typing import List, Dict, Any, Optional

from shapely.geometry import shape, MultiPolygon, Polygon
from shapely import wkb

from shared.models import (
	LabelPayloadData,
	Label,
	AOI,
	aoi_insert_payload,
	LabelDataEnum,
	LabelSourceEnum,
	DEFAULT_MODEL_PREFERENCES,
)
from shared.db import use_client
from shared.settings import settings
from shared.logger import logger
from shared.logging import LogContext, LogCategory
from shared.retry import retry_on_transient_error, is_statement_timeout

# Each chunk is inserted as a single SQL statement, which must finish within the
# database ``statement_timeout`` (8s for the ``authenticated`` role in production).
# Insert time scales with both the byte size *and* the number of rows (each row
# updates the spatial index), so we cap on both. These are first-line limits;
# ``_insert_records_adaptive`` handles any chunk that still exceeds the budget.
# A single polygon can exceed the byte target; it stays one feature and uses
# binary input with no geometry echoed in the response.
MAX_CHUNK_SIZE = 1024 * 1024 * 2  # 2MB of WKB per chunk
MAX_CHUNK_GEOMETRIES = 2000  # rows per chunk


def create_label_with_geometries(
	payload: LabelPayloadData, user_id: str, token: str, *, is_active: bool = True
) -> Label:
	"""Creates a label with associated AOI and geometries, handling large geometry uploads
	through chunking.

	Uploads remain inactive at version 0 until complete. Set ``is_active=False``
	when the caller will publish the completed label through the versioning RPC.
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
					response = client.table(settings.aois_table).insert(aoi_insert_payload(aoi)).execute()
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
		model_metadata=payload.model_metadata,
		is_active=False,
		version=0,
	)

	# Each PostgREST request commits separately. Keep incomplete uploads inactive.
	with use_client(token) as client:
		try:
			# Insert label
			response = (
				client.table(settings.labels_table)
				.insert(label.model_dump(by_alias=True, exclude={'id', 'created_at', 'updated_at'}))
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

			# Split geometries into chunks
			current_chunk_size = 0
			current_chunk = []

			for polygon in polygons:
				# Convert to WKB to estimate size
				wkb_geom = wkb.dumps(polygon)
				geom_size = len(wkb_geom)

				exceeds_size = current_chunk_size + geom_size > MAX_CHUNK_SIZE
				exceeds_count = len(current_chunk) >= MAX_CHUNK_GEOMETRIES
				if current_chunk and (exceeds_size or exceeds_count):
					# Upload current chunk
					upload_geometry_chunk(client, geom_table, label_id, current_chunk, payload.properties, token)
					current_chunk = []
					current_chunk_size = 0

				current_chunk.append(polygon)
				current_chunk_size += geom_size

			# Upload remaining geometries
			if current_chunk:
				upload_geometry_chunk(client, geom_table, label_id, current_chunk, payload.properties, token)

			if is_active:

				@retry_on_transient_error
				def activate():
					return (
						client.table(settings.labels_table)
						.update({'is_active': True, 'version': 1})
						.eq('id', label_id)
						.execute()
					)

				response = activate()
			return Label(**response.data[0])

		except Exception as e:
			logger.error(f'Error creating label: {str(e)}', extra={'token': token, 'user_id': user_id})
			raise Exception(f'Error creating label: {str(e)}')


def upload_geometry_chunk(
	client,
	table: str,
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

		# PostGIS accepts EWKB directly. Preserve every coordinate and hole in one
		# feature while avoiding costly nested GeoJSON parsing for huge polygons.
		geometry_records.append(
			{'label_id': label_id, 'geometry': wkb.dumps(geom, hex=True, srid=4326), 'properties': properties}
		)

	try:
		_insert_records_adaptive(client, table, geometry_records, label_id, token)
	except Exception as e:
		logger.error(f'Error uploading geometry chunk: {str(e)}', extra={'token': token})
		raise Exception(f'Error uploading geometry chunk: {str(e)}')


def _insert_records_adaptive(client, table: str, records: List[dict], label_id: int, token: str) -> None:
	"""Insert ``records`` as one statement, splitting the batch if the DB cancels it.

	A Postgres ``statement_timeout`` (SQLSTATE 57014) means the batch was too large
	to insert within the time budget; the whole statement is rolled back atomically
	(no partial rows), so we can safely halve the batch and retry each half. This
	recurses down to a single record, which — if it *still* times out — is a genuine
	problem and is re-raised. Transient network errors are handled per-insert by
	``retry_on_transient_error`` and are not split.
	"""
	try:
		_insert_records_with_retry(client, table, records, label_id)
	except Exception as e:
		if is_statement_timeout(e) and len(records) > 1:
			mid = len(records) // 2
			logger.warning(
				f'Geometry insert hit statement timeout for {len(records)} records; '
				f'splitting into {mid} + {len(records) - mid} and retrying',
				extra={'token': token},
			)
			_insert_records_adaptive(client, table, records[:mid], label_id, token)
			_insert_records_adaptive(client, table, records[mid:], label_id, token)
		else:
			raise


def _insert_records_with_retry(client, table: str, records: List[dict], label_id: int) -> None:
	"""Insert a single batch, retrying only on transient network failures.

	One uploader owns each newly created label. Each insert is atomic, so a retry
	must observe either the baseline count or baseline + batch size. If the count
	cannot be verified, fail without blindly duplicating a possibly committed batch.
	"""

	@retry_on_transient_error(is_retryable=is_statement_timeout)
	def _count_existing() -> int:
		# Retrying this read is safe even when a previous INSERT has an unknown
		# outcome. Never fall back to an unknown baseline for the subsequent write.
		response = client.table(table).select('id', count='exact', head=True).eq('label_id', label_id).execute()
		if response.count is None:
			raise RuntimeError('Cannot verify geometry upload count')
		return response.count

	count_before = None

	@retry_on_transient_error
	def _insert() -> None:
		nonlocal count_before
		try:
			count = _count_existing()
		except Exception as exc:
			if is_statement_timeout(exc):
				# Only a cancelled INSERT is safe to split, never a failed count.
				raise RuntimeError('Cannot verify geometry upload count') from exc
			raise
		if count_before is None:
			count_before = count
		elif count == count_before + len(records):
			return
		elif count != count_before:
			raise RuntimeError('Geometry upload count changed unexpectedly')
		# Echoing a huge geometry adds DB serialization work without any useful data.
		client.table(table).insert(records, returning='minimal').execute()

	_insert()


def delete_model_prediction_labels(
	dataset_id: int, label_data: LabelDataEnum, token: str, model_config: Optional[Dict[str, Any]] = None
) -> int:
	"""Deletes model prediction labels for a dataset with the specified label data type.

	Args:
		dataset_id: The ID of the dataset to delete labels for
		label_data: The label data type (e.g., deadwood, forest_cover)
		token: Authentication token
		model_config: If provided, delete labels whose model_metadata matches all keys/values.
			Legacy labels with no model_config are also deleted so reruns replace pre-versioned predictions.

	Returns:
		int: Number of labels deleted
	"""
	deleted_count = 0

	with use_client(token) as client:
		try:
			# First, get all model prediction labels for this dataset with the specified label data type
			response = (
				client.table(settings.labels_table)
				.select('id,model_config')
				.eq('dataset_id', dataset_id)
				.eq('label_source', LabelSourceEnum.model_prediction.value)
				.eq('label_data', label_data.value)
				.execute()
			)

			if model_config:
				labels_to_delete = [
					label
					for label in response.data
					if label.get('model_config') is None
					or all(label.get('model_config', {}).get(key) == value for key, value in model_config.items())
				]
			else:
				labels_to_delete = response.data

			if not labels_to_delete:
				# No existing labels found
				return 0

			# Get label IDs to delete
			label_ids = [label['id'] for label in labels_to_delete]
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

			logger.info(
				f'Deleted {deleted_count} existing model prediction labels for dataset {dataset_id}',
				LogContext(category=LogCategory.LABEL, dataset_id=dataset_id, token=token),
			)
			return deleted_count

		except Exception as e:
			logger.error(
				f'Error deleting model prediction labels: {str(e)}', extra={'token': token, 'dataset_id': dataset_id}
			)
			raise Exception(f'Error deleting model prediction labels: {str(e)}')


def get_model_preferences(token: Optional[str] = None) -> Dict[LabelDataEnum, Dict[str, Any]]:
	"""Return the preferred model_config per label_data type from v2_model_preferences.

	Returns a dict mapping LabelDataEnum -> model_config dict.
	Label data types with no preference row use the legacy model defaults.
	"""
	with use_client(token) as client:
		response = client.table(settings.model_preferences_table).select('label_data,model_config').execute()

	preferences = {label_data: dict(config) for label_data, config in DEFAULT_MODEL_PREFERENCES.items()}
	preferences.update({LabelDataEnum(row['label_data']): row['model_config'] for row in (response.data or [])})
	return preferences
