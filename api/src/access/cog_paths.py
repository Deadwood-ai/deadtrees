"""Hand out COG paths one dataset at a time, capped per account or network.

The database only lists COG paths to callers who need them in bulk (see the
cog_path_readers migration). Everyone else opens a dataset's map through this
module, which counts distinct datasets per requester over a rolling day so a
script cannot walk the whole archive. Reopening a dataset is free.
"""

from typing import Optional

from shared.settings import settings

from .tickets import keyed_digest


class CogPathLimitReached(Exception):
	"""The requester opened their daily number of distinct dataset maps."""


def requester_key(user_id: Optional[str], client_ip: Optional[str]) -> str:
	"""Signed-in callers count per account, anonymous ones per (hashed) client IP."""
	if user_id:
		return f'user:{user_id}'
	return f'ip:{keyed_digest(client_ip or "unknown")}'


def claim_cog_path(client, requester: str, dataset_id: int) -> Optional[str]:
	"""The dataset's static COG path, or None when it has no public COG.

	Raises CogPathLimitReached once the requester's daily cap is used up.
	"""
	rows = (
		client.rpc(
			'claim_public_cog_path',
			{'p_dataset_id': dataset_id, 'p_requester': requester, 'p_limit': settings.COG_PATHS_PER_DAY},
		)
		.execute()
		.data
	)
	if not rows:
		return None
	if not rows[0]['allowed']:
		raise CogPathLimitReached
	return rows[0]['cog_path']
