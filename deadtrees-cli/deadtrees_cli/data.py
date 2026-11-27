from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
from pathlib import Path
import sys
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
	DEFAULT_QUEUE_PRIORITY,
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
from shared.processing_tasks import UPLOAD_TASK_TYPES
from shared.upload_duplicates import (
	DUPLICATE_UPLOAD_CODE,
	DuplicateUploadError,
	find_existing_upload,
	reject_duplicate_upload,
)
from shared.logger import logger
from shared.upload_validation import ensure_processable_upload

# Python exits 1 on an uncaught exception and Fire exits 2 on a usage error, so
# neither can mean "not uploaded".
NOT_UPLOADED_EXIT_STATUS = 3


CHUNK_ATTEMPTS = 8
RETRYABLE_STATUS_CODES = {408, 429, 500, 502, 503, 504}


# Optional dataset fields a chunk carries only when set.
_OPTIONAL_FIELDS = [
	'project_id',
	'aquisition_year',
	'aquisition_month',
	'aquisition_day',
	'additional_information',
	'citation_doi',
]
_CONTRACT_FIELDS = ['license', 'platform', 'data_access', *_OPTIONAL_FIELDS]
# Chunks in flight at once (DT-1568); the server places each at index * chunk_size.
PARALLEL_CHUNKS = 3


def _same_metadata(contract: dict, form_data: dict) -> bool:
	"""The server binds an upload ID to its metadata; a resume must send exactly the same.

	An upload started before parallel sending has no chunk size in its contract; it
	still matches, and continues in order (see _find_resumable_upload).
	"""
	if contract.get('chunk_size') not in (None, int(form_data['chunk_size'])):
		return False
	authors = form_data['authors']
	# Fire passes a single `--authors` value as a string, which the form sends as one author.
	if list(contract.get('authors') or []) != ([authors] if isinstance(authors, str) else list(authors)):
		return False
	if bool(contract.get('allow_duplicate')) != ('allow_duplicate' in form_data):
		return False
	return all(
		(None if contract.get(field) is None else str(contract[field])) == form_data.get(field) for field in _CONTRACT_FIELDS
	)


def _received_bytes_match(file, chunks: list[dict | None], chunk_size: int) -> bool:
	"""Every received chunk has this file's size and SHA-256 at its offset, so a resume never mixes two files."""
	for index, chunk in enumerate(chunks):
		if chunk is None:
			continue
		file.seek(index * chunk_size)
		data = file.read(chunk_size)
		if len(data) != chunk['size'] or hashlib.sha256(data).hexdigest() != chunk['sha256']:
			return False
	return True


def _find_resumable_upload(
	client: httpx.Client, token: str, file, file_name: str, chunk_size: int, form_data: dict
) -> tuple[str, list[int], bool] | None:
	"""(upload ID, chunks still to send, parallel) of the caller's unfinished upload of this file, if any."""
	api = settings.API_ENDPOINT.rstrip('/') + '/datasets/uploads'
	headers = {'Authorization': f'Bearer {token}'}
	try:
		response = client.get(api, headers=headers)
		# An API without resume support answers 404 or 405: upload from the start.
		if response.status_code != 200:
			return None
		chunks_total = int(form_data['chunks_total'])
		for upload in response.json():
			contract = upload.get('contract') or {}
			if upload.get('state') != 'receiving' or contract.get('file_name') != file_name:
				continue
			if upload.get('chunks_total') != chunks_total or not _same_metadata(contract, form_data):
				continue
			detail = client.get(f"{api}/{upload['upload_id']}", headers=headers)
			if detail.status_code != 200:
				continue
			chunks = detail.json().get('chunks') or []
			received = sum(chunk is not None for chunk in chunks)
			if received != detail.json()['chunks_received'] or not _received_bytes_match(file, chunks, chunk_size):
				continue
			missing = [index for index in range(chunks_total) if index >= len(chunks) or chunks[index] is None]
			# All chunks arrived but the last reply was lost: send the last chunk again to finish.
			return upload['upload_id'], missing or [chunks_total - 1], contract.get('chunk_size') is not None
	except httpx.TransportError:
		return None
	return None


def _raise_for_duplicate_upload(response: httpx.Response) -> None:
	"""The API also rejects duplicates at finalisation, e.g. when another upload finished meanwhile."""
	if response.status_code != 409:
		return
	detail = response.json().get('detail')
	if isinstance(detail, dict) and detail.get('code') == DUPLICATE_UPLOAD_CODE:
		raise DuplicateUploadError(detail.get('existing_dataset_id'))


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

	def check_upload(self, *file_paths: str) -> None:
		"""Report which local files are already on the platform; uploads and deletes nothing.

		Prints one tab-separated line per file: `uploaded`, the dataset ID (`hidden`
		for a dataset this login may not see) and the path; `not_uploaded`, `-` and the
		path; or `error`, the reason and the path for a file it cannot read.

		Exit status: 0 when every file is uploaded, 3 when all could be checked and any
		is not uploaded. Anything else means the check failed.

		A match means the same fingerprint (shared/hash.py: file size, first and last
		10 MB), in a dataset that may belong to someone else. It does not prove the whole
		file is identical or that the dataset processed successfully, so it is not enough
		on its own to delete a local copy.
		"""
		if not file_paths:
			raise ValueError('Name at least one file')
		token = self._ensure_auth()
		failed = not_uploaded = False
		for file_path in file_paths:
			try:
				# Fire turns a file name like 2023 into an int.
				existing = find_existing_upload(Path(str(file_path)), token)
			except OSError as error:
				failed = True
				print(f'error\t{error.strerror}\t{file_path}')
				continue
			if existing is None:
				not_uploaded = True
				print(f'not_uploaded\t-\t{file_path}')
			else:
				print(f'uploaded\t{existing["dataset_id"] or "hidden"}\t{file_path}')
		if failed:
			sys.exit(1)
		if not_uploaded:
			sys.exit(NOT_UPLOADED_EXIT_STATUS)

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
		allow_duplicate: bool = False,
	):
		"""Upload a dataset to the API

		Raises UnprocessableUploadError, before signing in or sending any bytes, when
		the file breaks a rule the API would reject it for once uploaded (a ZIP without
		usable photos or GPS positions, a GeoTIFF without a CRS). Raises
		DuplicateUploadError, also before any bytes are sent, when the file is
		already on the platform, unless allow_duplicate explicitly uploads it as a
		new dataset anyway.
		"""
		file_path = Path(file_path)
		ensure_processable_upload(file_path)
		token = self._ensure_auth()
		if not allow_duplicate:
			reject_duplicate_upload(file_path, token)

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
			allow_duplicate=allow_duplicate,
		)

		return dataset

	def _chunked_upload(
		self,
		file_path: Path,
		token: str,
		chunk_size: int = 100 * 1024 * 1024,  # 100MB chunks
		**metadata,
	):
		"""Upload a file in chunks with a progress bar, continuing an unfinished upload of it.

		Sends PARALLEL_CHUNKS chunks at once with a declared chunk size. A stopped run
		resumes on the next run: the server lists the caller's unfinished uploads
		(GET /datasets/uploads), and one of the same file name, chunk count and
		metadata whose received chunks all match this file continues with the missing
		chunks. Each chunk is retried on network errors and server busy or error replies.
		"""
		file_size = file_path.stat().st_size
		chunks_total = (file_size + chunk_size - 1) // chunk_size
		form_data = {
			'chunks_total': str(chunks_total),
			'license': metadata['license'].value,
			'platform': metadata['platform'].value,
			'authors': metadata['authors'],
			'data_access': metadata['data_access'].value,
		}
		for field in _OPTIONAL_FIELDS:
			if metadata.get(field) is not None:
				form_data[field] = str(metadata[field])
		if metadata.get('allow_duplicate'):
			form_data['allow_duplicate'] = 'true'

		form_data['chunk_size'] = str(chunk_size)

		logger.info(f'Uploading file: {file_path}, to endpoint: {settings.API_ENDPOINT}')
		with open(file_path, 'rb') as f, httpx.Client(timeout=httpx.Timeout(timeout=300.0)) as client:
			resumable = _find_resumable_upload(client, token, f, file_path.name, chunk_size, form_data)
			upload_id, missing, parallel = resumable or (str(uuid.uuid4()), list(range(chunks_total)), True)
			if not parallel:
				# Started before parallel sending: continue in order, without a chunk size.
				del form_data['chunk_size']
			if resumable:
				logger.info(f'Continuing upload {upload_id} of {file_path.name}: {len(missing)} of {chunks_total} chunks to send')
			done = file_size - sum(min(chunk_size, file_size - index * chunk_size) for index in missing)
			progress = tqdm(total=file_size, initial=max(done, 0), unit='B', unit_scale=True, desc=f'Uploading {file_path.name}')

			def send(index: int) -> dict:
				# Each worker opens the file itself: no shared position across threads.
				with open(file_path, 'rb') as chunk_file:
					chunk_file.seek(index * chunk_size)
					data = chunk_file.read(chunk_size)
				response = self._send_chunk(
					client,
					{**form_data, 'chunk_index': str(index), 'upload_id': upload_id},
					{'file': (file_path.name, data, 'application/octet-stream')},
				)
				progress.update(len(data))
				return response.json()

			try:
				pool = ThreadPoolExecutor(max_workers=PARALLEL_CHUNKS if parallel else 1)
				try:
					futures = [pool.submit(send, index) for index in missing]
					replies = []
					for future in as_completed(futures):
						# The first failure stops the chunks that have not started yet.
						replies.append(future.result())
				finally:
					pool.shutdown(wait=True, cancel_futures=True)
				final = next((reply for reply in replies if reply.get('id')), None)
				if final is None:
					# Another chunk than the last completed the upload; its dataset is in the status.
					status = client.get(
						f"{settings.API_ENDPOINT.rstrip('/')}/datasets/uploads/{upload_id}",
						headers={'Authorization': f'Bearer {self._token or token}'},
					).json()
					final = status.get('response')
				if not final:
					raise RuntimeError('Upload finished without a dataset response')
				return final
			except Exception as e:
				logger.error(f'Error uploading {file_path.name} (upload {upload_id}): {e}. Run the upload again to continue it.')
				raise
			finally:
				progress.close()

	def _send_chunk(self, client: httpx.Client, form_data: dict, files: dict) -> httpx.Response:
		"""POST one chunk; retry network errors, busy and server errors, and an expired login."""
		for attempt in range(1, CHUNK_ATTEMPTS + 1):
			try:
				response = client.post(
					settings.API_ENTPOINT_DATASETS,
					files=files,
					data=form_data,
					headers={'Authorization': f'Bearer {self._token or self._ensure_auth()}'},
				)
			except httpx.TransportError as error:
				if attempt == CHUNK_ATTEMPTS:
					raise
				logger.warning(f'Chunk {form_data["chunk_index"]} failed ({error}); retrying')
			else:
				if response.status_code == 401 and attempt < CHUNK_ATTEMPTS:
					self._token = None
				elif response.status_code not in RETRYABLE_STATUS_CODES or attempt == CHUNK_ATTEMPTS:
					_raise_for_duplicate_upload(response)
					response.raise_for_status()
					return response
				logger.warning(f'Chunk {form_data["chunk_index"]} got HTTP {response.status_code}; retrying')
			time.sleep(min(2**attempt, 30))
		raise RuntimeError('unreachable')

	def process(
		self, dataset_id: int, task_types: Optional[List[str]] = None, priority: int = DEFAULT_QUEUE_PRIORITY
	):
		"""
		Start processing tasks for a dataset

		Args:
			dataset_id: ID of the dataset to process
			task_types: List of task types to process. Defaults to the full upload pipeline
				(UPLOAD_TASK_TYPES, the same stages a website upload runs)
			priority: Task priority (5=highest, 1=lowest). Defaults to DEFAULT_QUEUE_PRIORITY (2).
		"""
		token = self._ensure_auth()

		if not task_types:
			task_types = [t.value for t in UPLOAD_TASK_TYPES]

		# Validate task types
		try:
			validated_task_types = [TaskTypeEnum(t).value for t in task_types]
		except ValueError as e:
			raise ValueError(f'Invalid task type: {str(e)}')

		# Validate priority
		if priority < 1 or priority > 5:
			raise ValueError('Priority must be between 1 (lowest) and 5 (highest)')

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

		# Convert labels to MultiPolygon GeoJSON with holes
		labels_geojson = {
			'type': 'MultiPolygon',
			'coordinates': [
				[[[float(coord[0]), float(coord[1])] for coord in polygon.exterior.coords]]
				+ [[[float(coord[0]), float(coord[1])] for coord in interior.coords] for interior in polygon.interiors]
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
						+ [
							[[float(coord[0]), float(coord[1])] for coord in interior.coords]
							for interior in poly.interiors
						]
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

		# Convert AOI to MultiPolygon GeoJSON with holes
		aoi_geojson = {
			'type': 'MultiPolygon',
			'coordinates': [
				[[[float(coord[0]), float(coord[1])] for coord in polygon.exterior.coords]]
				+ [[[float(coord[0]), float(coord[1])] for coord in interior.coords] for interior in polygon.interiors]
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
