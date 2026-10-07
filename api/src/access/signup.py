"""Create accounts behind a captcha.

Public sign-up is switched off in Supabase, so this is the only way to create an
account. Supabase's own captcha also guards password logins, which would lock out
the processors and API scripts, so the captcha is checked here instead. The
account is created unconfirmed through the admin API and the confirmation link is
emailed by us; the caller always gets the same answer so it cannot probe which
emails already have accounts.
"""

import logging
from typing import Optional

import requests
from supabase_auth.errors import AuthApiError

from shared.db import use_service_client
from shared.notifications.email import send_email
from shared.notifications.templates import confirm_signup_email
from shared.settings import settings

logger = logging.getLogger(__name__)

TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
# Cloudflare's documented test secret that accepts every token; development only.
TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA'
EXISTING_ACCOUNT_CODES = {'email_exists', 'user_already_exists'}


class SignupRejected(Exception):
	"""A sign-up the caller can fix, such as a weak password."""


def _captcha_secret() -> Optional[str]:
	if settings.TURNSTILE_SECRET_KEY:
		return settings.TURNSTILE_SECRET_KEY
	return TURNSTILE_TEST_SECRET if settings.DEV_MODE else None


def captcha_passes(token: str, client_ip: Optional[str]) -> bool:
	secret = _captcha_secret()
	if not secret:
		raise RuntimeError('TURNSTILE_SECRET_KEY is not configured')
	payload = {'secret': secret, 'response': token}
	if client_ip:
		payload['remoteip'] = client_ip
	response = requests.post(TURNSTILE_VERIFY_URL, data=payload, timeout=10)
	response.raise_for_status()
	return response.json().get('success') is True


def create_account(email: str, password: str, redirect_to: Optional[str]) -> None:
	"""Create an unconfirmed account and email its confirmation link; silent for known emails."""
	options = {'redirect_to': redirect_to} if redirect_to else {}
	try:
		with use_service_client() as client:
			link = client.auth.admin.generate_link(
				{'type': 'signup', 'email': email, 'password': password, 'options': options}
			)
	except AuthApiError as error:
		if error.code in EXISTING_ACCOUNT_CODES:
			logger.info('Sign-up for an existing account ignored')
			return
		if error.status in (400, 422):
			raise SignupRejected(error.message) from error
		raise
	subject, text_body, html_body = confirm_signup_email(link.properties.action_link)
	send_email(email, subject, html_body, text_body=text_body)
