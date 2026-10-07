"""Create accounts behind a captcha.

Public sign-up is switched off in Supabase, so this is the only way to create an
account. Supabase's own captcha also guards password logins, which would lock out
the processors and API scripts, so the captcha is checked here instead. A new
account is created unconfirmed through the admin API and the confirmation link is
emailed by us. The caller always gets the same answer so it cannot probe which
emails already have accounts.

An account that exists but was never confirmed may carry a password chosen by
someone else who registered the address first. Its password is therefore replaced
with a random one and the owner of the inbox chooses their own through a recovery
link, so nobody but the inbox owner can sign in once the address is confirmed.
A new account whose confirmation email could not be sent is deleted again, so
retrying is an ordinary sign-up with the password the person chose.
"""

import logging
import secrets
from typing import Optional
from urllib.parse import urlsplit

import requests
from supabase_auth.errors import AuthApiError

from shared.db import use_service_client
from shared.notifications.email import send_email
from shared.notifications.templates import confirm_signup_email, finish_signup_email
from shared.settings import settings

logger = logging.getLogger(__name__)

TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
# Cloudflare's documented test secret that accepts every token; development only.
TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA'
EXISTING_ACCOUNT_CODES = {'email_exists', 'user_already_exists'}


class SignupRejected(Exception):
	"""A sign-up the caller can fix, such as a weak password."""


class SignupEmailFailed(Exception):
	"""The confirmation email was not accepted for delivery; signing up again retries it."""


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


def _set_password_url(redirect_to: Optional[str]) -> Optional[str]:
	"""The reset-password page on the site the sign-up came from."""
	if not redirect_to:
		return None
	parts = urlsplit(redirect_to)
	return f'{parts.scheme}://{parts.netloc}/reset-password' if parts.scheme and parts.netloc else None


def create_account(email: str, password: str, redirect_to: Optional[str]) -> None:
	"""Start or restart an account's confirmation by email; silent for confirmed accounts."""
	with use_service_client() as client:
		existing = client.rpc('signup_account_state', {'p_email': email}).execute().data
		if existing and existing[0]['confirmed']:
			logger.info('Sign-up for a confirmed account ignored')
			return
		if existing:
			client.auth.admin.update_user_by_id(existing[0]['user_id'], {'password': secrets.token_urlsafe(32)})
			options = {'redirect_to': url} if (url := _set_password_url(redirect_to)) else {}
			link = client.auth.admin.generate_link({'type': 'recovery', 'email': email, 'options': options})
			subject, text_body, html_body = finish_signup_email(link.properties.action_link)
		else:
			options = {'redirect_to': redirect_to} if redirect_to else {}
			try:
				link = client.auth.admin.generate_link(
					{'type': 'signup', 'email': email, 'password': password, 'options': options}
				)
			except AuthApiError as error:
				if error.code in EXISTING_ACCOUNT_CODES:
					logger.info('Sign-up raced with another sign-up for the same email')
					return
				if error.status in (400, 422):
					raise SignupRejected(error.message) from error
				raise
			subject, text_body, html_body = confirm_signup_email(link.properties.action_link)
		if send_email(email, subject, html_body, text_body=text_body).get('success'):
			return
		if not existing:
			# Undo the new account so a retry is an ordinary sign-up with the chosen password.
			try:
				client.auth.admin.delete_user(link.user.id)
			except Exception:
				# The account stays unconfirmed; a retry restarts it through the recovery path.
				logger.exception('Could not undo a new account after its confirmation email failed')
	raise SignupEmailFailed
