"""Platform-wide privileges from ``privileged_users``, for API-side checks."""

import time

from shared.db import use_service_client

CORE_TEAM_CACHE_SECONDS = 30
_core_team: dict[str, tuple[float, bool]] = {}


def user_is_core_team(user_id: str) -> bool:
	"""Whether the user has the core-team (``can_audit``) privilege.

	Cached for a few seconds per user: a page of benchmark images asks once per file.
	"""
	now = time.monotonic()
	cached = _core_team.get(user_id)
	if cached and cached[0] > now:
		return cached[1]
	with use_service_client() as client:
		rows = (
			client.table('privileged_users')
			.select('user_id')
			.eq('user_id', user_id)
			.eq('can_audit', True)
			.limit(1)
			.execute()
			.data
		)
	_core_team[user_id] = (now + CORE_TEAM_CACHE_SECONDS, bool(rows))
	return bool(rows)
