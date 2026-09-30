from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security.oauth2 import OAuth2PasswordRequestForm

from shared.db import login as supabase_login

router = APIRouter()


@router.post('/token')
async def login(form_data: Annotated[OAuth2PasswordRequestForm, Depends()]):
	"""
	This login function is not used in the Forntend.

	It is needed for the documentation, to actually test the API and for all
	use-cases where a Python script is uploading data to the API.

	"""
	# Always sign in with the submitted credentials; never reuse a cached session.
	try:
		token = supabase_login(form_data.username, form_data.password, use_cached_session=False)
	except Exception:
		raise HTTPException(status_code=401, detail='Invalid email or password')

	# return the response as FastAPI needs it
	return {'access_token': token, 'token_type': 'bearer'}
