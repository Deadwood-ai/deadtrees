from typing import List, Optional

from fastapi import HTTPException

from shared.models import Dataset, LicenseEnum, PlatformEnum, DatasetAccessEnum
from shared.db import use_client
from shared.settings import settings
from shared.logger import logger


def create_dataset_entry(
	user_id: str,
	file_name: str,
	license: LicenseEnum,
	platform: PlatformEnum,
	authors: List[str],
	project_id: Optional[str],
	aquisition_year: Optional[int],
	aquisition_month: Optional[int],
	aquisition_day: Optional[int],
	additional_information: Optional[str],
	data_access: DatasetAccessEnum,
	citation_doi: Optional[str],
	token: str,
) -> Dataset:
	"""Create a new dataset entry in the database"""
	data = {
		'user_id': user_id,
		'file_name': file_name,
		'license': license,
		'platform': platform,
		'authors': authors,
		'project_id': project_id,
		'aquisition_year': aquisition_year,
		'aquisition_month': aquisition_month,
		'aquisition_day': aquisition_day,
		'additional_information': additional_information,
		'data_access': data_access,
		'citation_doi': citation_doi,
	}

	dataset = Dataset(**data)

	with use_client(token) as client:
		try:
			send_data = {k: v for k, v in dataset.model_dump().items() if k != 'id' and v is not None}
			response = client.table(settings.datasets_table).insert(send_data).execute()
			return Dataset(**response.data[0])
		except Exception as e:
			logger.exception(f'Error creating dataset entry: {str(e)}', extra={'token': token})
			raise HTTPException(status_code=400, detail=f'Error creating dataset entry: {str(e)}')
