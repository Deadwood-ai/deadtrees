import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

import httpx

from shared.settings import settings


logger = logging.getLogger(__name__)
BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email'


def send_email(
	to_email: str,
	subject: str,
	html_body: str,
	to_name: Optional[str] = None,
	text_body: Optional[str] = None,
	idempotency_key: Optional[str] = None,
) -> dict:
	"""Send a transactional email through Mailpit in development or Brevo otherwise."""
	if settings.DEV_MODE:
		return _send_via_smtp(to_email, subject, html_body, to_name, text_body)
	return _send_via_brevo(to_email, subject, html_body, to_name, text_body, idempotency_key)


def _send_via_smtp(
	to_email: str,
	subject: str,
	html_body: str,
	to_name: Optional[str] = None,
	text_body: Optional[str] = None,
) -> dict:
	try:
		msg = MIMEMultipart('alternative')
		msg['Subject'] = subject
		msg['From'] = f'{settings.NOTIFICATION_SENDER_NAME} <{settings.NOTIFICATION_SENDER_EMAIL}>'
		msg['To'] = f'{to_name} <{to_email}>' if to_name else to_email
		if text_body:
			msg.attach(MIMEText(text_body, 'plain'))
		msg.attach(MIMEText(html_body, 'html'))

		with smtplib.SMTP(settings.MAILPIT_SMTP_HOST, settings.MAILPIT_SMTP_PORT) as server:
			server.send_message(msg)

		logger.info('Transactional email accepted by local SMTP')
		return {'success': True, 'message_id': None, 'method': 'smtp'}
	except Exception as exc:
		logger.error(f'Local SMTP delivery failed: {exc}')
		return {'success': False, 'error': 'smtp_delivery_failed', 'method': 'smtp'}


def _send_via_brevo(
	to_email: str,
	subject: str,
	html_body: str,
	to_name: Optional[str] = None,
	text_body: Optional[str] = None,
	idempotency_key: Optional[str] = None,
) -> dict:
	if not settings.BREVO_API_KEY:
		logger.error('BREVO_API_KEY not configured')
		return {'success': False, 'error': 'BREVO_API_KEY not configured', 'method': 'brevo'}

	recipient = {'email': to_email}
	if to_name:
		recipient['name'] = to_name

	payload = {
		'sender': {
			'email': settings.NOTIFICATION_SENDER_EMAIL,
			'name': settings.NOTIFICATION_SENDER_NAME,
		},
		'to': [recipient],
		'subject': subject,
		'htmlContent': html_body,
	}
	if text_body:
		payload['textContent'] = text_body
	if idempotency_key:
		payload['headers'] = {'idempotencyKey': idempotency_key}

	try:
		with httpx.Client(timeout=15) as client:
			response = client.post(
				BREVO_API_URL,
				json=payload,
				headers={'api-key': settings.BREVO_API_KEY, 'Content-Type': 'application/json'},
			)

		if response.status_code in (200, 201):
			data = response.json()
			return {'success': True, 'message_id': data.get('messageId'), 'method': 'brevo'}

		if response.status_code == 400 and 'duplicate_parameter' in response.text:
			return {'success': True, 'message_id': None, 'method': 'brevo', 'duplicate': True}

		error_code = f'brevo_api_error_{response.status_code}'
		logger.error(error_code)
		return {'success': False, 'error': error_code, 'method': 'brevo'}
	except Exception as exc:
		logger.error(f'Brevo delivery failed: {type(exc).__name__}')
		return {'success': False, 'error': 'brevo_delivery_failed', 'method': 'brevo'}
