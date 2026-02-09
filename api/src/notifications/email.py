"""
Email notification module for DeadTrees.

In development: sends via SMTP to local Mailpit (captured, verifiable via API).
In production: sends via Brevo transactional email API.
"""

import smtplib
import logging
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional

import httpx

from shared.settings import settings

logger = logging.getLogger(__name__)

BREVO_API_URL = "https://api.brevo.com/v3/smtp/email"


def send_email(
	to_email: str,
	subject: str,
	html_body: str,
	to_name: Optional[str] = None,
) -> dict:
	"""
	Send a transactional email.

	In development: routes to local Mailpit via SMTP for testing.
	In production: routes to Brevo API for delivery + tracking.

	Returns:
		dict with 'success' (bool) and 'message_id' or 'error'.
	"""
	if settings.DEV_MODE:
		return _send_via_smtp(to_email, subject, html_body, to_name)
	else:
		return _send_via_brevo(to_email, subject, html_body, to_name)


def _send_via_smtp(
	to_email: str,
	subject: str,
	html_body: str,
	to_name: Optional[str] = None,
) -> dict:
	"""Send email via SMTP (Mailpit in dev)."""
	try:
		msg = MIMEMultipart('alternative')
		msg['Subject'] = subject
		msg['From'] = f"{settings.NOTIFICATION_SENDER_NAME} <{settings.NOTIFICATION_SENDER_EMAIL}>"
		msg['To'] = f"{to_name} <{to_email}>" if to_name else to_email

		msg.attach(MIMEText(html_body, 'html'))

		with smtplib.SMTP(settings.MAILPIT_SMTP_HOST, settings.MAILPIT_SMTP_PORT) as server:
			server.send_message(msg)

		logger.info(f"Email sent via SMTP to {to_email}: {subject}")
		return {"success": True, "message_id": None, "method": "smtp"}

	except Exception as e:
		logger.error(f"Failed to send email via SMTP to {to_email}: {e}")
		return {"success": False, "error": str(e), "method": "smtp"}


def _send_via_brevo(
	to_email: str,
	subject: str,
	html_body: str,
	to_name: Optional[str] = None,
) -> dict:
	"""Send email via Brevo transactional API."""
	if not settings.BREVO_API_KEY:
		logger.error("BREVO_API_KEY not configured")
		return {"success": False, "error": "BREVO_API_KEY not configured", "method": "brevo"}

	headers = {
		"api-key": settings.BREVO_API_KEY,
		"Content-Type": "application/json",
	}

	recipient = {"email": to_email}
	if to_name:
		recipient["name"] = to_name

	payload = {
		"sender": {
			"email": settings.NOTIFICATION_SENDER_EMAIL,
			"name": settings.NOTIFICATION_SENDER_NAME,
		},
		"to": [recipient],
		"subject": subject,
		"htmlContent": html_body,
	}

	try:
		with httpx.Client(timeout=15) as client:
			response = client.post(BREVO_API_URL, json=payload, headers=headers)

		if response.status_code in (200, 201):
			data = response.json()
			message_id = data.get("messageId")
			logger.info(f"Email sent via Brevo to {to_email}: {subject} (id: {message_id})")
			return {"success": True, "message_id": message_id, "method": "brevo"}
		else:
			error_msg = f"Brevo API error {response.status_code}: {response.text}"
			logger.error(error_msg)
			return {"success": False, "error": error_msg, "method": "brevo"}

	except Exception as e:
		logger.error(f"Failed to send email via Brevo to {to_email}: {e}")
		return {"success": False, "error": str(e), "method": "brevo"}
