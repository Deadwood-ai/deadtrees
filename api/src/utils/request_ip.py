"""Resolve the client IP of an API request behind the host nginx proxy.

Host nginx reaches the API through Docker's bridge gateway and overwrites
``X-Real-IP`` with ``$remote_addr``. ``X-Forwarded-For`` is appendable and can
carry client-supplied spoofed hops, so it is never used. ``X-Real-IP`` is only
trusted when the direct peer is a configured proxy
(``SEARCH_RATE_LIMIT_TRUSTED_PROXIES``); otherwise the peer address is the client.
"""

import logging
from functools import lru_cache
from ipaddress import ip_address, ip_network

from starlette.requests import HTTPConnection

from shared.settings import settings

logger = logging.getLogger(__name__)


@lru_cache(maxsize=16)
def trusted_proxy_networks(config: str) -> tuple:
	networks = []
	for raw_entry in config.split(','):
		entry = raw_entry.strip()
		if not entry:
			continue
		try:
			networks.append(ip_network(entry, strict=False))
		except ValueError:
			logger.warning('Ignoring invalid trusted proxy entry')
	return tuple(networks)


def _is_trusted_proxy(host: str | None) -> bool:
	if not host:
		return False
	try:
		address = ip_address(host)
	except ValueError:
		return False
	return any(address in network for network in trusted_proxy_networks(settings.SEARCH_RATE_LIMIT_TRUSTED_PROXIES))


def _is_ip(host: str) -> bool:
	try:
		ip_address(host)
	except ValueError:
		return False
	return True


def get_client_ip(request: HTTPConnection) -> str | None:
	"""Return the client IP, or None when the request has no peer address."""
	client_host = request.client.host if request.client else None
	if _is_trusted_proxy(client_host):
		real_ip = request.headers.get('x-real-ip', '').strip()
		if real_ip and _is_ip(real_ip):
			return real_ip

	return client_host or None
