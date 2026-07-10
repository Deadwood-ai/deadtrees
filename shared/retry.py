import functools
import time
from typing import Callable, Optional, TypeVar

from shared.logger import logger

T = TypeVar('T')

# Substrings (matched case-insensitively against the exception message) that
# indicate a transient network failure worth retrying, rather than a
# deterministic programming or validation error.
#
# These cover the failures we have actually observed killing datasets mid-run:
# "Server disconnected without sending a response." and
# "The write operation timed out" — both raised when the DB/storage backend
# briefly drops the connection during an insert/update.
TRANSIENT_ERROR_PATTERNS = (
	'server disconnected',
	'timed out',
	'timeout',
	'connection reset',
	'connection aborted',
	'connection refused',
	'connection error',
	'connection closed',
	'temporarily unavailable',
	'broken pipe',
	'remoteprotocolerror',
	'read operation',
	'write operation',
	'eof occurred',
	'name or service not known',
	# paramiko SSH connection establishment hiccups (storage server transfers)
	'protocol banner',
	'error reading ssh',
	'no existing session',
)

# A Postgres statement timeout is *deterministic*, not a network blip: the same
# statement, re-issued unchanged, will exceed the same time budget and be cancelled
# again. Blindly retrying it (its message contains "timeout", so it would otherwise
# match TRANSIENT_ERROR_PATTERNS) just burns every attempt to no effect. Callers must
# instead make the statement smaller (e.g. split the batch), so we classify it as
# non-transient.
#
# We match on the "statement timeout" *message*, NOT on SQLSTATE 57014 alone: 57014
# is Postgres's generic query_canceled code, also raised for user/admin cancellations
# (pg_cancel_backend -> "canceling statement due to user request"). Those must
# propagate, not be split-and-retried, so only the timeout message qualifies.
STATEMENT_TIMEOUT_PATTERNS = (
	'canceling statement due to statement timeout',
	'statement timeout',
)


def is_statement_timeout(exc: BaseException) -> bool:
	"""True if the exception is a Postgres statement_timeout cancellation.

	Deliberately keyed on the statement-timeout message rather than SQLSTATE 57014,
	which also covers non-timeout query cancellations that should not be split/retried.
	"""
	message = str(exc).lower()
	return any(pattern in message for pattern in STATEMENT_TIMEOUT_PATTERNS)


def is_transient_error(exc: BaseException) -> bool:
	"""Heuristic for whether an exception looks like a transient network failure.

	We match on the message rather than exception type because the failures
	bubble up through several layers (supabase -> httpx -> httpcore) and get
	re-wrapped as plain ``Exception`` along the way, so the type is unreliable
	but the underlying message is preserved.

	A Postgres statement timeout is explicitly excluded: it looks like a timeout
	but is deterministic, so retrying it unchanged never helps (see
	``STATEMENT_TIMEOUT_PATTERNS``).
	"""
	if is_statement_timeout(exc):
		return False
	message = str(exc).lower()
	return any(pattern in message for pattern in TRANSIENT_ERROR_PATTERNS)


def retry_on_transient_error(
	func: Optional[Callable[..., T]] = None,
	*,
	max_attempts: int = 4,
	initial_delay: float = 1.0,
	backoff: float = 2.0,
	max_delay: float = 30.0,
	is_retryable: Callable[[BaseException], bool] = is_transient_error,
	verify_succeeded: Optional[Callable[[], bool]] = None,
) -> Callable:
	"""Retry a function on transient network errors with exponential backoff.

	Non-transient errors (validation errors, programming bugs) are re-raised
	immediately without retrying, as is the final attempt's error once
	``max_attempts`` is exhausted.

	Usable both bare (``@retry_on_transient_error``) and parameterised
	(``@retry_on_transient_error(max_attempts=5)``).

	Idempotency: a retried write could otherwise produce duplicate rows if the
	original write committed server-side but the response was lost (e.g.
	"disconnected without sending a response"). Pass ``verify_succeeded`` — a
	callback that re-reads state and returns True if the operation already took
	effect — to suppress the retry in that case. If the verification check
	itself fails, we fall through to a normal retry rather than giving up.
	"""

	def decorator(fn: Callable[..., T]) -> Callable[..., T]:
		@functools.wraps(fn)
		def wrapper(*args, **kwargs) -> T:
			delay = initial_delay
			for attempt in range(1, max_attempts + 1):
				try:
					return fn(*args, **kwargs)
				except Exception as exc:
					if not is_retryable(exc):
						raise

					# The write may have committed before the connection dropped;
					# if so, don't re-issue it (avoids duplicate rows).
					if verify_succeeded is not None:
						try:
							if verify_succeeded():
								logger.warning(
									f'{fn.__name__} hit a transient error but the operation '
									f'already committed; not retrying: {exc}'
								)
								return None  # type: ignore[return-value]
						except Exception as verify_exc:
							logger.warning(
								f'{fn.__name__} could not verify whether the operation '
								f'committed, will retry: {verify_exc}'
							)

					if attempt >= max_attempts:
						raise
					logger.warning(
						f'{fn.__name__} failed with transient error '
						f'(attempt {attempt}/{max_attempts}), retrying in {delay:.1f}s: {exc}'
					)
					time.sleep(delay)
					delay = min(delay * backoff, max_delay)
			# Loop always either returns or raises; this is unreachable.
			raise RuntimeError('retry_on_transient_error exhausted without returning')  # pragma: no cover

		return wrapper

	if func is not None:
		return decorator(func)
	return decorator
