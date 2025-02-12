from supabase import create_client, ClientOptions, Client
from contextlib import contextmanager
from typing import Generator, Optional
from shared.settings import settings


@contextmanager
def use_client(access_token: Optional[str] = None) -> Generator[Client, None, None]:
	client = create_client(
		settings.SUPABASE_URL,
		settings.SUPABASE_KEY,
		options=ClientOptions(auto_refresh_token=False),
	)
	try:
		if access_token is not None:
			client.postgrest.auth(token=access_token)
		yield client
	finally:
		pass
