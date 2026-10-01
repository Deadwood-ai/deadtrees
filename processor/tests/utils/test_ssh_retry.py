import paramiko
import pytest

from processor.src.utils.ssh import _connect_with_retry

pytestmark = pytest.mark.unit


class _FakeSSH:
	"""Minimal stand-in for paramiko.SSHClient recording connect attempts."""

	def __init__(self, fail_times, exc):
		self.fail_times = fail_times
		self.exc = exc
		self.attempts = 0

	def connect(self, **kwargs):
		self.attempts += 1
		if self.attempts <= self.fail_times:
			raise self.exc


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
	monkeypatch.setattr('shared.retry.time.sleep', lambda d: None)


def test_connect_retries_on_protocol_banner_then_succeeds():
	ssh = _FakeSSH(fail_times=2, exc=paramiko.SSHException('Error reading SSH protocol banner'))

	_connect_with_retry(ssh, hostname='host', port=22)

	assert ssh.attempts == 3


def test_connect_gives_up_after_max_attempts():
	ssh = _FakeSSH(fail_times=99, exc=paramiko.SSHException('Error reading SSH protocol banner'))

	with pytest.raises(paramiko.SSHException, match='protocol banner'):
		_connect_with_retry(ssh, hostname='host', port=22)

	# Default max_attempts is 4.
	assert ssh.attempts == 4


def test_connect_does_not_retry_auth_failure():
	"""A bad key is deterministic; retrying would just waste time."""
	ssh = _FakeSSH(fail_times=99, exc=paramiko.AuthenticationException('Authentication failed'))

	with pytest.raises(paramiko.AuthenticationException):
		_connect_with_retry(ssh, hostname='host', port=22)

	assert ssh.attempts == 1


def test_storage_sftp_bounds_connect_and_stalled_transfers(monkeypatch):
	from contextlib import contextmanager

	import processor.src.utils.ssh as ssh_module
	from shared.settings import settings

	connect_kwargs = {}
	channel_timeouts = []

	class _Channel:
		def settimeout(self, seconds):
			channel_timeouts.append(seconds)

	class _Sftp:
		def get_channel(self):
			return _Channel()

		def __enter__(self):
			return self

		def __exit__(self, *exc):
			return False

	class _Client:
		def connect(self, **kwargs):
			connect_kwargs.update(kwargs)

		def open_sftp(self):
			return _Sftp()

	@contextmanager
	def fake_client(known_hosts):
		yield _Client()

	monkeypatch.setattr(ssh_module, 'create_verified_ssh_client', fake_client)
	monkeypatch.setattr(ssh_module.paramiko.Ed25519Key, 'from_private_key_file', lambda path: 'key')
	monkeypatch.setattr(ssh_module.logger, 'info', lambda *args, **kwargs: None)

	with ssh_module._storage_sftp('token', 1):
		pass

	for name in ('timeout', 'banner_timeout', 'auth_timeout'):
		assert connect_kwargs[name] == settings.SSH_CONNECT_TIMEOUT_SECONDS
	assert channel_timeouts == [settings.SSH_TRANSFER_STALL_SECONDS]
