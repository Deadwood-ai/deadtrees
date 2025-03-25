from functools import wraps
from typing import Callable, TypeVar, Any
from shared.settings import settings

T = TypeVar('T')


def ensure_test_environment() -> None:
	"""
	Verify that the current environment is safe for running tests.
	Raises RuntimeError if environment is not safe.
	"""
	if settings.ENV.lower() not in ['development', 'test']:
		raise RuntimeError(
			'CRITICAL SAFETY ERROR: Attempted to run test utilities in '
			f'{settings.ENV} environment. Tests can only run in development or test environments.'
		)

	if not settings.DEV_MODE:
		raise RuntimeError(
			'CRITICAL SAFETY ERROR: Attempted to run test utilities without DEV_MODE enabled. '
			'Tests can only run with DEV_MODE=True'
		)


def test_environment_only(func: Callable[..., T]) -> Callable[..., T]:
	"""
	Decorator to ensure a function only runs in test environments.
	Can be used on fixtures, test functions, or cleanup utilities.
	"""

	@wraps(func)
	def wrapper(*args: Any, **kwargs: Any) -> T:
		ensure_test_environment()
		return func(*args, **kwargs)

	return wrapper
