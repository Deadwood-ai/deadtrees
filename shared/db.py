from typing import Union, Literal, Optional, Generator, Any
from contextlib import contextmanager
import hmac
import time
import logging

from pydantic import BaseModel
from shared.models import StatusEnum
from supabase import create_client, ClientOptions, Client
from shared.settings import settings

# Create logger instance at module level
logger = logging.getLogger(__name__)

# Sessions of service accounts (the processor), by email, together with the
# password they were created with. A different password never matches, so one
# account can never receive another account's token or skip the password check.
_cached_sessions: dict[str, tuple[str, Any]] = {}


def login(user: str, password: str, use_cached_session: bool = True) -> str:
	"""
	Sign in with email and password and return an access token.

	With ``use_cached_session`` a still-valid session for the same credentials is
	reused, so long-running service accounts do not sign in on every call.
	Requests on behalf of end users must pass ``use_cached_session=False``.
	"""
	threshold = 60 * 20  # renew 20 minutes before expiration

	if use_cached_session and user in _cached_sessions:
		cached_password, cached = _cached_sessions[user]
		if hmac.compare_digest(cached_password, password) and cached.session.expires_at > int(time.time()) + threshold:
			return cached.session.access_token

	client = create_client(
		settings.SUPABASE_URL,
		settings.SUPABASE_KEY,
		options=ClientOptions(auto_refresh_token=False),
	)
	try:
		auth_response = client.auth.sign_in_with_password({'email': user, 'password': password})
	except Exception as e:
		raise Exception(f'Login failed: {str(e)}')
	if use_cached_session:
		_cached_sessions[user] = (password, auth_response)
	return auth_response.session.access_token


def login_verified(user: str, password: str) -> tuple[str, Union[Literal[False], Any]]:
	"""
	Log in and verify the resulting token, retrying once without using the cached
	session if the first token is stale or invalid.
	"""
	token = login(user, password)
	user_obj = verify_token(token)
	if user_obj:
		return token, user_obj

	token = login(user, password, use_cached_session=False)
	user_obj = verify_token(token)
	return token, user_obj


def verify_token(jwt: str) -> Union[Literal[False], Any]:
	"""Verifies a user jwt token string against the active supabase sessions

	Args:
	    jwt (str): A jwt token string

	Returns:
	    Union[Literal[False], Any]: Returns true if user session is active, false if not
	"""
	try:
		with use_client(jwt) as client:
			response = client.auth.get_user(jwt)
		return response.user
	except Exception:
		# A rejected token must not be served from the cache again.
		for user, (_, cached) in list(_cached_sessions.items()):
			if cached.session.access_token == jwt:
				_cached_sessions.pop(user, None)
		return False


@contextmanager
def use_client(access_token: Optional[str] = None) -> Generator[Client, None, None]:
	"""Creates and returns a supabase client session

	Args:
	    access_token (Optional[str], optional): Optional access token. Defaults to None.

	Yields:
	    Generator[Client, None, None]: A supabase client session
	"""
	# create a supabase client
	client = create_client(
		settings.SUPABASE_URL,
		settings.SUPABASE_KEY,
		options=ClientOptions(auto_refresh_token=False),
	)

	# yield the client
	try:
		# set the access token to the postgrest (rest-api) client if available
		if access_token is not None:
			client.postgrest.auth(token=access_token)

		yield client
	finally:
		pass


@contextmanager
def use_anon_client() -> Generator[Client, None, None]:
	"""Creates a Supabase client that acts as an anonymous (logged-out) visitor.

	``use_client()`` without a token uses SUPABASE_KEY, which is the service-role
	key in the test stack, so it cannot stand in for the anon role.
	"""
	if not settings.SUPABASE_ANON_KEY:
		raise ValueError('SUPABASE_ANON_KEY is required for anonymous database access')

	client = create_client(
		settings.SUPABASE_URL,
		settings.SUPABASE_ANON_KEY,
		options=ClientOptions(auto_refresh_token=False),
	)

	try:
		yield client
	finally:
		pass


@contextmanager
def use_service_client() -> Generator[Client, None, None]:
	"""Creates a Supabase service-role client for server-side privileged writes."""
	if not settings.SUPABASE_SERVICE_ROLE_KEY:
		raise ValueError('SUPABASE_SERVICE_ROLE_KEY is required for service-role database access')

	client = create_client(
		settings.SUPABASE_URL,
		settings.SUPABASE_SERVICE_ROLE_KEY,
		options=ClientOptions(auto_refresh_token=False),
	)

	try:
		yield client
	finally:
		pass


@contextmanager
def use_anon_client(access_token: Optional[str] = None) -> Generator[Client, None, None]:
	"""Creates a Supabase client that behaves like an anonymous/public caller."""
	if not settings.SUPABASE_ANON_KEY:
		raise ValueError('SUPABASE_ANON_KEY is required for anonymous/public client access')

	client = create_client(
		settings.SUPABASE_URL,
		settings.SUPABASE_ANON_KEY,
		options=ClientOptions(auto_refresh_token=False),
	)

	try:
		if access_token is not None:
			client.postgrest.auth(token=access_token)

		yield client
	finally:
		pass


class SupabaseReader(BaseModel):
	Model: type[BaseModel]
	table: str
	token: str | None = None

	def by_id(self, dataset_id: int) -> BaseModel | None:
		"""Reads an instance from the bound model from
		supabase.
		"""
		# figure out the primary field - prioritize dataset_id over id
		if 'dataset_id' in self.Model.model_fields:
			id_field = 'dataset_id'
		elif 'id' in self.Model.model_fields:
			id_field = 'id'
		else:
			raise AttributeError('Model does not have an id field')

		with use_client(self.token) as client:
			result = client.table(self.table).select('*').eq(id_field, dataset_id).execute()

		if len(result.data) == 0:
			return None

		return self.Model(**result.data[0])
