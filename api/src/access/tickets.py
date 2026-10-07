"""Short-lived signed path segments for private dataset files.

Browsers load COG ranges, thumbnails and finished downloads without an
Authorization header, so the API hands out a ticket that names the user, one
resource and an expiry. A ticket only identifies the requester: every request
that presents one is still checked against the user's current dataset access,
so revocation and grant expiry apply even while a ticket is valid.
"""

import base64
import hashlib
import hmac
import json
import time
import re
from typing import Optional

from pydantic import BaseModel

from shared.settings import settings


class Ticket(BaseModel):
	user_id: str
	resource: str
	expires_at: int


def _signing_key() -> bytes:
	if settings.ASSET_TICKET_SECRET:
		return settings.ASSET_TICKET_SECRET.encode()
	service_key = settings.SUPABASE_SERVICE_ROLE_KEY or settings.SUPABASE_KEY
	if not service_key:
		raise RuntimeError('No key is configured for signing private file paths')
	return hmac.new(service_key.encode(), b'deadtrees-private-file-ticket-v1', hashlib.sha256).digest()


def _encode(payload: dict) -> str:
	raw = json.dumps(payload, separators=(',', ':'), sort_keys=True).encode()
	return base64.urlsafe_b64encode(raw).decode().rstrip('=')


def _signature(encoded: str) -> str:
	return hmac.new(_signing_key(), encoded.encode(), hashlib.sha256).hexdigest()


def keyed_digest(value: str) -> str:
	"""A stable digest of a value (such as a client IP) that cannot be reversed without the key."""
	return hmac.new(_signing_key(), f'digest:{value}'.encode(), hashlib.sha256).hexdigest()


def sign_ticket(user_id: str, resource: str) -> tuple[str, int]:
	"""Sign a ticket for one resource, e.g. ``cog:42``. Returns the path segment and its expiry."""
	expires_at = int(time.time()) + settings.ASSET_TICKET_TTL_SECONDS
	encoded = _encode({'u': str(user_id), 'r': resource, 'e': expires_at})
	return f'{encoded}.{_signature(encoded)}', expires_at


def read_ticket(value: str, resource: str) -> Optional[Ticket]:
	"""Return the ticket when its signature, resource and expiry are valid."""
	encoded, _, signature = value.partition('.')
	if not encoded or not signature or not hmac.compare_digest(_signature(encoded), signature):
		return None
	try:
		payload = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
		ticket = Ticket(user_id=payload['u'], resource=payload['r'], expires_at=payload['e'])
	except (ValueError, KeyError, TypeError):
		return None
	if ticket.resource != resource or ticket.expires_at <= time.time():
		return None
	return ticket


_TICKET_PATH = re.compile(r'(/(?:datasets/\d+/files/(?:cog|thumbnail)|exports)/)[^/?\s]+')


def redact_file_tickets(record) -> bool:
	"""Keep request diagnostics without writing bearer file tickets to access logs."""
	if isinstance(record.args, tuple):
		record.args = tuple(
			_TICKET_PATH.sub(r'\1[redacted]', value) if isinstance(value, str) else value for value in record.args
		)
	return True
