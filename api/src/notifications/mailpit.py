"""
Mailpit API helper for verifying emails in tests.

Mailpit is the local email testing server used in the Supabase dev stack.
It captures all SMTP emails and exposes a REST API for programmatic verification.

API docs: https://mailpit.axllent.org/docs/api-v1/
"""

import time
import logging
from typing import Optional

import httpx

from shared.settings import settings

logger = logging.getLogger(__name__)


def get_mailpit_api_url() -> str:
	"""Get the Mailpit API base URL."""
	return settings.MAILPIT_API_URL


def purge_messages() -> bool:
	"""Delete all messages in Mailpit. Useful before tests."""
	url = f"{get_mailpit_api_url()}/api/v1/messages"
	try:
		response = httpx.delete(url, timeout=5)
		return response.status_code == 200
	except Exception as e:
		logger.error(f"Failed to purge Mailpit messages: {e}")
		return False


def get_messages(limit: int = 50) -> list[dict]:
	"""
	Get all messages from Mailpit.

	Returns:
		List of message dicts with keys like 'ID', 'Subject', 'To', 'From', etc.
	"""
	url = f"{get_mailpit_api_url()}/api/v1/messages"
	try:
		response = httpx.get(url, params={"limit": limit}, timeout=5)
		if response.status_code == 200:
			data = response.json()
			return data.get("messages", [])
		return []
	except Exception as e:
		logger.error(f"Failed to get Mailpit messages: {e}")
		return []


def get_message_by_id(message_id: str) -> Optional[dict]:
	"""Get a single message by ID, including full HTML body."""
	url = f"{get_mailpit_api_url()}/api/v1/message/{message_id}"
	try:
		response = httpx.get(url, timeout=5)
		if response.status_code == 200:
			return response.json()
		return None
	except Exception as e:
		logger.error(f"Failed to get Mailpit message {message_id}: {e}")
		return None


def wait_for_messages(
	expected_count: int = 1,
	timeout_seconds: float = 5.0,
	poll_interval: float = 0.3,
) -> list[dict]:
	"""
	Wait until the expected number of messages appear in Mailpit.

	Args:
		expected_count: Minimum number of messages to wait for.
		timeout_seconds: How long to wait before giving up.
		poll_interval: Seconds between polling attempts.

	Returns:
		List of messages if found, empty list on timeout.
	"""
	deadline = time.time() + timeout_seconds
	while time.time() < deadline:
		messages = get_messages()
		if len(messages) >= expected_count:
			return messages
		time.sleep(poll_interval)

	# Final attempt
	return get_messages()


def find_message_by_subject(subject: str, timeout_seconds: float = 5.0) -> Optional[dict]:
	"""
	Wait for and find a message by exact subject match.

	Returns:
		Message dict or None if not found within timeout.
	"""
	messages = wait_for_messages(expected_count=1, timeout_seconds=timeout_seconds)
	for msg in messages:
		if msg.get("Subject") == subject:
			return msg
	return None


def assert_email_received(
	expected_subject: str,
	expected_to: str,
	timeout_seconds: float = 5.0,
) -> dict:
	"""
	Assert that an email matching the criteria was received by Mailpit.

	Args:
		expected_subject: The exact subject line to match.
		expected_to: The recipient email address.
		timeout_seconds: How long to wait.

	Returns:
		The matching message dict.

	Raises:
		AssertionError if no matching email is found.
	"""
	messages = wait_for_messages(expected_count=1, timeout_seconds=timeout_seconds)

	assert len(messages) > 0, "No emails received in Mailpit"

	# Find matching message
	for msg in messages:
		subject_match = msg.get("Subject") == expected_subject
		to_addresses = [addr.get("Address", "") for addr in msg.get("To", [])]
		to_match = expected_to in to_addresses

		if subject_match and to_match:
			return msg

	# Build detailed error message
	found_subjects = [m.get("Subject") for m in messages]
	found_to = [
		[a.get("Address") for a in m.get("To", [])]
		for m in messages
	]
	raise AssertionError(
		f"Expected email with subject='{expected_subject}' to='{expected_to}' not found.\n"
		f"Found {len(messages)} email(s):\n"
		f"  Subjects: {found_subjects}\n"
		f"  To: {found_to}"
	)
