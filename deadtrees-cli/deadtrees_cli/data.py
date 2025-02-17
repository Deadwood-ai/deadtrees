from pathlib import Path
from typing import Optional, List, Dict, Any
import time
import httpx
from tqdm import tqdm
import uuid

from shared.db import login, verify_token, use_client
from shared.settings import settings
from shared.models import Dataset, TaskTypeEnum, PlatformEnum, DatasetAccessEnum, Label, LabelDataEnum, LicenseEnum
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
		start_processing: bool = True,
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

		if start_processing:
			self.process(dataset['id'])

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

	def process(self, dataset_id: int, task_types: Optional[List[str]] = None):
		"""
		Start processing tasks for a dataset

		Args:
		    dataset_id: ID of the dataset to process
		    task_types: List of task types to process. Defaults to ['cog', 'thumbnail']
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

		logger.info(f'Starting processing for dataset {dataset_id} with tasks: {validated_task_types}')

		try:
			with httpx.Client() as client:
				response = client.put(
					f'{settings.API_ENDPOINT}/datasets/{dataset_id}/process',
					json={'task_types': validated_task_types},
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
