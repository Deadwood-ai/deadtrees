import paramiko
import pytest

from processor.src.utils.ssh import _connect_with_retry


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
