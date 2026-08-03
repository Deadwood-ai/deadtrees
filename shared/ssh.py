from pathlib import Path

import paramiko


def create_verified_ssh_client(known_hosts_path: str) -> paramiko.SSHClient:
	"""Create an SSH client that trusts only explicitly provisioned host keys."""
	client = paramiko.SSHClient()
	client.load_host_keys(str(Path(known_hosts_path).expanduser()))
	client.set_missing_host_key_policy(paramiko.RejectPolicy())
	return client
