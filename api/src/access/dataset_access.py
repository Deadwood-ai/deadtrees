"""Fresh database authorization for each delivery request, across all API workers."""

from typing import Iterable, Optional

from shared.db import use_service_client


def user_can_view_dataset(dataset_id: int, user_id: Optional[str]) -> bool:
	with use_service_client() as client:
		return bool(
			client.rpc('user_can_view_dataset', {'p_dataset_id': dataset_id, 'p_user_id': user_id}).execute().data
		)


def user_can_download_datasets(dataset_ids: Iterable[int], kind, user_id: str) -> bool:
	"""Whether the user may download every listed dataset as this export kind, in one query."""
	with use_service_client() as client:
		return bool(
			client.rpc(
				'user_can_download_datasets',
				{'p_dataset_ids': list(dataset_ids), 'p_kind': kind.value, 'p_user_id': user_id},
			)
			.execute()
			.data
		)
