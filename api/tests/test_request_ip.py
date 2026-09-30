from types import SimpleNamespace

import pytest

from api.src.utils.request_ip import get_client_ip, trusted_proxy_networks
from shared.settings import settings

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def _trusted_proxies(monkeypatch):
	monkeypatch.setattr(settings, 'SEARCH_RATE_LIMIT_TRUSTED_PROXIES', '172.16.0.0/12')
	trusted_proxy_networks.cache_clear()
	yield
	trusted_proxy_networks.cache_clear()


def _request(host, headers=None):
	client = SimpleNamespace(host=host) if host else None
	return SimpleNamespace(headers=headers or {}, client=client)


def test_untrusted_peer_ignores_spoofed_forwarding_headers():
	request = _request('198.51.100.7', {'x-forwarded-for': '203.0.113.10', 'x-real-ip': '203.0.113.11'})

	assert get_client_ip(request) == '198.51.100.7'


def test_trusted_proxy_supplies_real_ip():
	request = _request('172.18.0.1', {'x-real-ip': '203.0.113.10'})

	assert get_client_ip(request) == '203.0.113.10'


def test_trusted_proxy_forwarded_for_is_ignored():
	request = _request('172.18.0.1', {'x-forwarded-for': '203.0.113.10, 172.18.0.1'})

	assert get_client_ip(request) == '172.18.0.1'


def test_trusted_proxy_invalid_real_ip_falls_back_to_peer():
	request = _request('172.18.0.1', {'x-real-ip': 'not an ip'})

	assert get_client_ip(request) == '172.18.0.1'


def test_missing_peer_returns_none():
	assert get_client_ip(_request(None)) is None
