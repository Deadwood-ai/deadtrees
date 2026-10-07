"""Small in-process sliding-window rate limiter keyed by client.

State lives in one API process and resets on restart, so it suits short windows
that only need to slow down a burst, not durable quotas.
"""

from collections import defaultdict, deque
from threading import Lock
from time import monotonic
from typing import Optional

from fastapi import HTTPException


class SlidingWindowLimiter:
	def __init__(self, limit: int, window_seconds: float, detail: str):
		self.limit = limit
		self.window_seconds = window_seconds
		self.detail = detail
		self._requests: dict[str, deque[float]] = defaultdict(deque)
		self._lock = Lock()

	def check(self, key: str, now: Optional[float] = None) -> None:
		"""Count one request for key, or raise 429 with Retry-After once the window is full."""
		now = monotonic() if now is None else now
		window_start = now - self.window_seconds
		with self._lock:
			self._prune(window_start)
			requests = self._requests[key]
			while requests and requests[0] <= window_start:
				requests.popleft()
			if len(requests) >= self.limit:
				retry_after = max(1, int(self.window_seconds - (now - requests[0])))
				raise HTTPException(status_code=429, detail=self.detail, headers={'Retry-After': str(retry_after)})
			requests.append(now)

	def _prune(self, window_start: float) -> None:
		"""Forget clients whose requests have all left the window, so memory stays bounded."""
		stale = [key for key, times in self._requests.items() if not times or times[-1] <= window_start]
		for key in stale:
			del self._requests[key]

	def clear(self) -> None:
		with self._lock:
			self._requests.clear()
