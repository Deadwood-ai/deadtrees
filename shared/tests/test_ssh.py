from pathlib import Path

import paramiko
import pytest

from shared.ssh import create_verified_ssh_client


def _write_known_host(path: Path, hostname: str, key: paramiko.PKey) -> None:
	path.write_text(f'{hostname} {key.get_name()} {key.get_base64()}\n')


def test_verified_client_loads_the_provisioned_host_key(tmp_path: Path):
	key = paramiko.RSAKey.generate(1024)
	known_hosts = tmp_path / 'known_hosts'
	_write_known_host(known_hosts, 'storage.example.test', key)

	with create_verified_ssh_client(str(known_hosts)) as client:
		loaded_key = client.get_host_keys().lookup('storage.example.test')[key.get_name()]

	assert loaded_key == key


def test_verified_client_rejects_an_unknown_host(tmp_path: Path):
	key = paramiko.RSAKey.generate(1024)
	known_hosts = tmp_path / 'known_hosts'
	_write_known_host(known_hosts, 'storage.example.test', key)

	with create_verified_ssh_client(str(known_hosts)) as client:
		client._log = lambda *_args: None
		with pytest.raises(paramiko.SSHException, match='not found in known_hosts'):
			client._policy.missing_host_key(client, 'unexpected.example.test', key)


def test_verified_client_fails_when_trust_store_is_missing(tmp_path: Path):
	with pytest.raises(FileNotFoundError):
		create_verified_ssh_client(str(tmp_path / 'missing-known-hosts'))
