from typing import Union, Generator, Literal, Optional
from contextlib import contextmanager

from supabase import create_client
from supabase.client import Client, ClientOptions
from gotrue import User

from .settings import settings


def login(user: str, password: str):
    """Creates a supabase client instance and authorizes the user with login and password to 
    return a supabase session.

    Args:
        user (str): Supabase username as email
        password (str): User password for supabase

    Returns:
        AuthResponse: Returns a new supabase session if the login was successful
    """
    # create a supabase client
    client = create_client(settings.supabase_url, settings.supabase_key, options=ClientOptions(auto_refresh_token=False))

    client.auth.sign_in_with_password({'email': user, 'password': password})
    auth_response = client.auth.refresh_session()
    
    # client.auth.sign_out()
    # client.auth.close()
    # return the response
    return auth_response


def verify_token(jwt: str) -> Union[Literal[False], User]:
    """Verifies a user jwt token string against the active supabase sessions

    Args:
        jwt (str): A jwt token string

    Returns:
        Union[Literal[False], User]: Returns true if user session is active, false if not
    """
    # make the authentication
    with use_client(jwt) as client:
        response = client.auth.get_user(jwt)
    
    # check the token
    try:
        return response.user
    except Exception:
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
    client = create_client(settings.supabase_url, settings.supabase_key, options=ClientOptions(auto_refresh_token=False))

    # yield the client
    try:
        # set the access token to the postgrest (rest-api) client if available
        if access_token is not None:
            client.postgrest.auth(token=access_token)
        
        yield client
    finally:
        #client.auth.sign_out()
        # client.auth.close()
        pass