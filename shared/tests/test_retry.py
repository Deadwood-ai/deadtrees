import pytest

from shared.retry import is_statement_timeout, is_transient_error, retry_on_transient_error


# ---------------------------------------------------------------------------
# is_transient_error
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
	'message',
	[
		'Server disconnected without sending a response.',
		'The write operation timed out',
		'Connection reset by peer',
		'Connection refused',
		'Temporarily unavailable',
		'[Errno 32] Broken pipe',
		'RemoteProtocolError: server disconnected',
		'Error reading SSH protocol banner',
	],
)
def test_is_transient_error_true_for_network_failures(message):
	assert is_transient_error(Exception(message)) is True


@pytest.mark.parametrize(
	'exc',
	[
		ValueError('Expected Polygon geometry, received MultiPolygon'),
		KeyError('dataset_id'),
		Exception('Invalid token'),
		Exception('duplicate key value violates unique constraint'),
	],
)
def test_is_transient_error_false_for_deterministic_errors(exc):
	assert is_transient_error(exc) is False


@pytest.mark.parametrize(
	'message',
	[
		'canceling statement due to statement timeout',
		"{'message': 'canceling statement due to statement timeout', 'code': '57014'}",
		'ERROR: statement timeout',
	],
)
def test_is_statement_timeout_true_for_postgres_cancellation(message):
	assert is_statement_timeout(Exception(message)) is True


@pytest.mark.parametrize(
	'message',
	[
		'The write operation timed out',
		'read operation timed out',
		'Server disconnected without sending a response.',
	],
)
def test_is_statement_timeout_false_for_network_timeouts(message):
	assert is_statement_timeout(Exception(message)) is False


@pytest.mark.parametrize(
	'message',
	[
		# SQLSTATE 57014 is generic query_canceled, not only statement_timeout: a
		# user/admin cancellation shares the code but must propagate, not be split.
		"{'message': 'canceling statement due to user request', 'code': '57014'}",
		'canceling statement due to user request',
	],
)
def test_is_statement_timeout_false_for_other_query_cancellations(message):
	assert is_statement_timeout(Exception(message)) is False
	# ...and such a cancellation is not a network transient either, so it propagates.
	assert is_transient_error(Exception(message)) is False


def test_statement_timeout_is_not_transient():
	"""A Postgres statement timeout contains 'timeout' but must NOT be retried."""
	exc = Exception("{'message': 'canceling statement due to statement timeout', 'code': '57014'}")
	assert is_transient_error(exc) is False


def test_statement_timeout_reraised_immediately_without_retry(no_sleep):
	calls = []

	@retry_on_transient_error
	def fn():
		calls.append(1)
		raise Exception('canceling statement due to statement timeout')

	with pytest.raises(Exception, match='statement timeout'):
		fn()

	assert len(calls) == 1
	assert no_sleep == []


# ---------------------------------------------------------------------------
# retry_on_transient_error
# ---------------------------------------------------------------------------


@pytest.fixture
def no_sleep(monkeypatch):
	"""Record backoff delays without actually sleeping."""
	delays = []
	monkeypatch.setattr('shared.retry.time.sleep', lambda d: delays.append(d))
	return delays


def test_returns_value_without_retry_on_success(no_sleep):
	calls = []

	@retry_on_transient_error
	def fn():
		calls.append(1)
		return 'ok'

	assert fn() == 'ok'
	assert len(calls) == 1
	assert no_sleep == []


def test_retries_then_succeeds_on_transient_error(no_sleep):
	calls = []

	@retry_on_transient_error(initial_delay=1.0, backoff=2.0)
	def fn():
		calls.append(1)
		if len(calls) < 3:
			raise Exception('Server disconnected without sending a response.')
		return 'recovered'

	assert fn() == 'recovered'
	assert len(calls) == 3
	# Slept between the two failed attempts, with exponential backoff.
	assert no_sleep == [1.0, 2.0]


def test_gives_up_after_max_attempts_and_reraises(no_sleep):
	calls = []

	@retry_on_transient_error(max_attempts=3)
	def fn():
		calls.append(1)
		raise Exception('The write operation timed out')

	with pytest.raises(Exception, match='write operation timed out'):
		fn()

	assert len(calls) == 3
	# Slept after attempts 1 and 2, but not after the final failure.
	assert len(no_sleep) == 2


def test_non_transient_error_raised_immediately_without_retry(no_sleep):
	calls = []

	@retry_on_transient_error
	def fn():
		calls.append(1)
		raise ValueError('Expected Polygon geometry, received MultiPolygon')

	with pytest.raises(ValueError, match='MultiPolygon'):
		fn()

	assert len(calls) == 1
	assert no_sleep == []


def test_backoff_is_capped_at_max_delay(no_sleep):
	@retry_on_transient_error(max_attempts=6, initial_delay=10.0, backoff=10.0, max_delay=30.0)
	def fn():
		raise Exception('connection reset')

	with pytest.raises(Exception, match='connection reset'):
		fn()

	# 10 -> 100 (capped 30) -> 30 -> 30 -> 30, then final failure (no sleep).
	assert no_sleep == [10.0, 30.0, 30.0, 30.0, 30.0]


def test_verify_succeeded_suppresses_retry_when_already_committed(no_sleep):
	calls = []

	@retry_on_transient_error(verify_succeeded=lambda: True)
	def fn():
		calls.append(1)
		raise Exception('Server disconnected without sending a response.')

	# Returns without raising: the verify callback reports the write landed.
	assert fn() is None
	assert len(calls) == 1  # the insert was attempted exactly once, not re-issued
	assert no_sleep == []


def test_verify_succeeded_false_still_retries(no_sleep):
	calls = []

	@retry_on_transient_error(max_attempts=3, verify_succeeded=lambda: False)
	def fn():
		calls.append(1)
		raise Exception('Server disconnected without sending a response.')

	with pytest.raises(Exception, match='disconnected'):
		fn()

	assert len(calls) == 3


def test_verify_succeeded_failure_falls_through_to_retry(no_sleep):
	calls = []

	def failing_verify():
		raise Exception('count query also failed')

	@retry_on_transient_error(max_attempts=2, verify_succeeded=failing_verify)
	def fn():
		calls.append(1)
		raise Exception('connection reset')

	# Verification raising must not crash the retry; it falls through and retries.
	with pytest.raises(Exception, match='connection reset'):
		fn()

	assert len(calls) == 2


def test_preserves_function_metadata():
	@retry_on_transient_error
	def my_named_function():
		"""docstring."""
		return 1

	assert my_named_function.__name__ == 'my_named_function'
	assert my_named_function.__doc__ == 'docstring.'
