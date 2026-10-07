from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security.oauth2 import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field

from shared.db import login as supabase_login

from ..access.signup import CaptchaUnavailable, SignupEmailFailed, SignupRejected, captcha_passes, create_account
from ..utils.request_ip import get_client_ip
from ..utils.sliding_window import SlidingWindowLimiter

router = APIRouter()

SIGNUPS_PER_IP_PER_HOUR = 5
_signup_limiter = SlidingWindowLimiter(
	SIGNUPS_PER_IP_PER_HOUR, 3600, 'Too many sign-ups from your network. Please try again later.'
)


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


class SignupRequest(BaseModel):
	email: str = Field(pattern=r'^[^@\s]+@[^@\s]+\.[^@\s]+$', max_length=254)
	password: str = Field(min_length=6, max_length=72)
	captcha_token: str = Field(min_length=1, max_length=4096)
	redirect_to: Optional[str] = Field(default=None, max_length=2048)


class SignupResponse(BaseModel):
	message: str


@router.post('/auth/signup', response_model=SignupResponse)
def signup(payload: SignupRequest, request: Request):
	"""Create an account after a captcha; the confirmation link arrives by email.

	The answer is the same whether or not the email already has an account.
	"""
	client_ip = get_client_ip(request)
	_signup_limiter.check(client_ip or 'unknown')
	try:
		passed = captcha_passes(payload.captcha_token, client_ip)
	except CaptchaUnavailable:
		raise HTTPException(status_code=503, detail='The captcha check is unavailable. Please try again in a minute.')
	if not passed:
		raise HTTPException(status_code=400, detail='The captcha check failed. Please try again.')
	try:
		create_account(payload.email, payload.password, payload.redirect_to)
	except SignupRejected as error:
		raise HTTPException(status_code=400, detail=str(error))
	except SignupEmailFailed:
		raise HTTPException(
			status_code=503, detail='We could not send the confirmation email. Please try again in a few minutes.'
		)
	return SignupResponse(message='Check your inbox for a link to confirm your email address.')
