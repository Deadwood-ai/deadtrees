"""Caller-bound, atomic visibility changes and audit history."""

from postgrest.exceptions import APIError
from fastapi import HTTPException
from shared.db import use_client
from shared.models import DatasetAccessEnum


def change_dataset_visibility(dataset_id: int, token: str, data_access: DatasetAccessEnum) -> DatasetAccessEnum:
	try:
		with use_client(token) as client:
			previous = (
				client.rpc(
					'set_dataset_visibility',
					{
						'p_dataset_id': dataset_id,
						'p_data_access': data_access.value,
					},
				)
				.execute()
				.data
			)
		return DatasetAccessEnum(previous)
	except APIError as error:
		status = {'P0002': 404, '42501': 403}.get(error.code)
		if status:
			raise HTTPException(
				status_code=status,
				detail='Dataset not found' if status == 404 else 'Only the dataset owner can change its visibility',
			) from error
		raise
