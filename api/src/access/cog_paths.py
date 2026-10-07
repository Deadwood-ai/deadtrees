"""Hand out COG paths one dataset at a time, capped per account or network.

The database only lists COG paths to callers who need them in bulk (see the
cog_path_readers migration). Everyone else opens a dataset's map through this
module, which counts distinct datasets per requester over a rolling day so a
script cannot walk the whole archive. Reopening a dataset is free.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from shared.settings import settings

from .tickets import keyed_digest

REQUESTS_TABLE = 'cog_path_requests'
WINDOW = timedelta(days=1)


def requester_key(user_id: Optional[str], client_ip: Optional[str]) -> str:
	"""Signed-in callers count per account, anonymous ones per (hashed) client IP."""
	if user_id:
		return f'user:{user_id}'
	return f'ip:{keyed_digest(client_ip or "unknown")}'


def claim_cog_path(client, requester: str, dataset_id: int, now: Optional[datetime] = None) -> bool:
	"""Record that the requester opened this dataset; False once their daily cap is used up."""
	now = now or datetime.now(timezone.utc)
	limit = settings.COG_PATHS_PER_DAY
	recent = (
		client.table(REQUESTS_TABLE)
		.select('dataset_id')
		.eq('requester', requester)
		.gte('created_at', (now - WINDOW).isoformat())
		.limit(limit + 1)
		.execute()
		.data
	)
	opened = {row['dataset_id'] for row in recent}
	if dataset_id in opened:
		return True
	if len(opened) >= limit:
		return False
	client.table(REQUESTS_TABLE).insert({'requester': requester, 'dataset_id': dataset_id}).execute()
	return True
