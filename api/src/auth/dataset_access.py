from typing import Optional, Union, Literal
from pydantic import BaseModel
from fastapi import HTTPException

from shared.db import use_client, login, verify_token
from shared.models import Dataset, Ortho
from shared.settings import settings


class DatasetAccessResult(BaseModel):
	"""Result of dataset access check containing dataset info and access status"""

	dataset: Optional[Dataset] = None
	ortho: Optional[dict] = None  # Raw ortho data from database
	is_public: bool = False
	is_authorized: bool = False
	user_id: Optional[str] = None


async def check_dataset_access(dataset_id: str, authorization_header: Optional[str] = None) -> DatasetAccessResult:
	"""
	Two-step verification for dataset access:
	1. Check if dataset exists using privileged connection
	2. Check if user has permission to access it

	Args:
	    dataset_id: The dataset ID to check
	    authorization_header: Optional Authorization header with Bearer token

	Returns:
	    DatasetAccessResult with access information

	Raises:
	    HTTPException: 404 if dataset not found, 401/403 for auth issues
	"""

	# Step 1: Check dataset existence using processor credentials (bypasses RLS)
	try:
		processor_token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

		with use_client(processor_token) as client:
			# Check if dataset exists
			dataset_response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()

			if not dataset_response.data:
				raise HTTPException(
					status_code=404,
					detail=f'Dataset <ID={dataset_id}> not found',
					headers={'error_code': 'DATASET_NOT_FOUND'},
				)

			dataset = Dataset(**dataset_response.data[0])

			# Get ortho data if available
			ortho_response = client.table(settings.orthos_table).select('*').eq('dataset_id', dataset_id).execute()
			ortho_data = ortho_response.data[0] if ortho_response.data else None

	except HTTPException:
		raise
	except Exception as e:
		raise HTTPException(status_code=500, detail=f'Error checking dataset existence: {str(e)}')

	# Check if dataset is public - allow access without authentication
	is_public = dataset.data_access.value != 'private'
	if is_public:
		return DatasetAccessResult(dataset=dataset, ortho=ortho_data, is_public=True, is_authorized=True, user_id=None)

	# Step 2: For private datasets, check user authorization
	if not authorization_header:
		raise HTTPException(
			status_code=401,
			detail='Authentication required to access private dataset',
			headers={'WWW-Authenticate': 'Bearer', 'error_code': 'AUTHENTICATION_REQUIRED'},
		)

	# Extract token from Authorization header
	if not authorization_header.startswith('Bearer '):
		raise HTTPException(
			status_code=401,
			detail='Invalid authorization header format',
			headers={'WWW-Authenticate': 'Bearer', 'error_code': 'INVALID_AUTH_HEADER'},
		)

	token = authorization_header[7:]  # Remove "Bearer " prefix

	# Verify token
	user = verify_token(token)
	if not user:
		raise HTTPException(
			status_code=401,
			detail='Invalid or expired token',
			headers={'WWW-Authenticate': 'Bearer', 'error_code': 'INVALID_TOKEN'},
		)

	# Check if user has access to this private dataset
	try:
		with use_client(token) as client:
			# Try to access the dataset with user's token
			# RLS policy will only return datasets the user can access
			user_dataset_response = client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute()

			has_access = len(user_dataset_response.data) > 0

			if not has_access:
				raise HTTPException(
					status_code=403,
					detail='Access denied to this private dataset',
					headers={'error_code': 'ACCESS_DENIED'},
				)

			return DatasetAccessResult(
				dataset=dataset, ortho=ortho_data, is_public=False, is_authorized=True, user_id=user.id
			)

	except HTTPException:
		raise
	except Exception as e:
		raise HTTPException(status_code=500, detail=f'Error checking user access: {str(e)}')
