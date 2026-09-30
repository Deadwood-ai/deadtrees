import os
import uuid
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

import paramiko

from shared.logger import logger
from shared.settings import settings
from shared.testing.safety import test_environment_only
from shared.retry import retry_on_transient_error
from shared.ssh import create_verified_ssh_client

from shared.logging import LogContext, LogCategory


@retry_on_transient_error
def _connect_with_retry(ssh: paramiko.SSHClient, **connect_kwargs) -> None:
	"""Open the SSH connection, retrying transient failures.

	Connection establishment is where the storage-server flakiness shows up
	("Error reading SSH protocol banner") when the server is briefly overloaded.
	Retrying only the connect (not the subsequent transfer) keeps this safe:
	there are no partial-file side effects to undo before reconnecting.
	"""
	ssh.connect(**connect_kwargs)


def pull_file_from_storage_server(remote_file_path: str, local_file_path: str, token: str, dataset_id: int):
	# Check if the file already exists locally
	if os.path.exists(local_file_path):
		logger.info(
			f'File already exists locally at: {local_file_path}',
			LogContext(category=LogCategory.SSH, token=token, dataset_id=dataset_id),
		)
		return

	with _storage_sftp(token, dataset_id) as sftp:
		logger.info(
			f'Pulling file from storage server: {remote_file_path} to {local_file_path}',
			LogContext(
				category=LogCategory.SSH,
				token=token,
				dataset_id=dataset_id,
				extra={'remote_path': remote_file_path, 'local_path': local_file_path},
			),
		)

		# Create the directory for local_file_path if it doesn't exist
		local_dir = Path(local_file_path).parent
		local_dir.mkdir(parents=True, exist_ok=True)
		# A partial download must never look like a complete local file on the next run.
		temp_local_path = f'{local_file_path}.{uuid.uuid4().hex}.tmp'
		try:
			sftp.get(remote_file_path, temp_local_path)
			os.replace(temp_local_path, local_file_path)
		finally:
			if os.path.exists(temp_local_path):
				os.remove(temp_local_path)

	# Check if the file exists after pulling
	if os.path.exists(local_file_path):
		logger.info(
			'File successfully pulled from storage server',
			LogContext(
				category=LogCategory.SSH,
				token=token,
				dataset_id=dataset_id,
				extra={'local_path': local_file_path, 'file_size': Path(local_file_path).stat().st_size},
			),
		)
	else:
		logger.error(
			'File not found after pulling from storage server',
			LogContext(
				category=LogCategory.SSH,
				token=token,
				dataset_id=dataset_id,
				extra={'remote_path': remote_file_path, 'local_path': local_file_path},
			),
		)


def storage_server_path(*parts: str) -> str:
	"""Absolute path on the storage server below ``STORAGE_SERVER_DATA_PATH``."""
	return '/'.join([settings.STORAGE_SERVER_DATA_PATH, *parts])


@contextmanager
def _storage_sftp(token: str, dataset_id: int | None):
	with create_verified_ssh_client(settings.SSH_KNOWN_HOSTS_PATH) as ssh:
		pkey = paramiko.Ed25519Key.from_private_key_file(settings.SSH_PRIVATE_KEY_PATH)
		logger.info(
			f'Connecting to storage server: {settings.STORAGE_SERVER_IP} as {settings.STORAGE_SERVER_USERNAME}',
			LogContext(category=LogCategory.SSH, token=token, dataset_id=dataset_id),
		)
		_connect_with_retry(
			ssh,
			hostname=settings.STORAGE_SERVER_IP,
			username=settings.STORAGE_SERVER_USERNAME,
			pkey=pkey,
			port=2222 if settings.DEV_MODE else 22,
		)
		with ssh.open_sftp() as sftp:
			yield sftp


def push_file_to_storage_server(local_file_path: str, remote_file_path: str, token: str, dataset_id: int):
	"""Upload to a unique temp name, then atomically rename over the final path.

	Readers see either the previous complete file or the new complete file, never
	a partial upload.
	"""
	with _storage_sftp(token, dataset_id) as sftp:
		temp_remote_path = f'{remote_file_path}.{uuid.uuid4().hex}.tmp'
		try:
			# Create parent directory if it doesn't exist (needed for UUID-prefixed paths)
			remote_dir = str(PurePosixPath(remote_file_path).parent)
			try:
				sftp.stat(remote_dir)
			except IOError:
				logger.info(
					'Creating remote directory',
					LogContext(
						category=LogCategory.SSH, token=token, dataset_id=dataset_id, extra={'remote_dir': remote_dir}
					),
				)
				sftp.mkdir(remote_dir)

			sftp.put(local_file_path, temp_remote_path)
			sftp.posix_rename(temp_remote_path, remote_file_path)

			logger.info(
				'File successfully pushed to storage server',
				LogContext(
					category=LogCategory.SSH,
					token=token,
					dataset_id=dataset_id,
					extra={'remote_path': remote_file_path},
				),
			)

		except Exception as e:
			try:
				sftp.remove(temp_remote_path)
			except IOError:
				pass

			logger.error(
				'Failed to push file to storage server',
				LogContext(
					category=LogCategory.SSH,
					token=token,
					dataset_id=dataset_id,
					extra={
						'error': str(e),
						'remote_path': remote_file_path,
						'local_path': local_file_path,
					},
				),
			)
			raise


def delete_superseded_storage_file(
	storage_dir: str, previous_path: str | None, current_path: str, token: str, dataset_id: int
) -> None:
	"""Best-effort removal of a replaced file once the database points at its successor.

	``previous_path`` and ``current_path`` are relative to ``storage_dir`` (for example
	``<uuid>/<file>``). Only a plain file name or a single UUID directory holding it
	is removed; anything else is left alone. Failures are logged, never raised.
	"""
	if not previous_path or previous_path == current_path:
		return
	parts = PurePosixPath(previous_path).parts
	if (
		PurePosixPath(previous_path).is_absolute()
		or len(parts) not in (1, 2)
		or any(part in ('', '.', '..') for part in parts)
		or (len(parts) == 2 and not _is_uuid(parts[0]))
	):
		logger.warning(
			f'Not deleting unexpected superseded storage path {previous_path!r}',
			LogContext(category=LogCategory.SSH, token=token, dataset_id=dataset_id),
		)
		return

	remote_file_path = storage_server_path(storage_dir, *parts)
	try:
		with _storage_sftp(token, dataset_id) as sftp:
			try:
				sftp.remove(remote_file_path)
			except FileNotFoundError:
				pass
			if len(parts) == 2:
				sftp.rmdir(storage_server_path(storage_dir, parts[0]))
		logger.info(
			f'Deleted superseded storage file {remote_file_path}',
			LogContext(category=LogCategory.SSH, token=token, dataset_id=dataset_id),
		)
	except Exception as e:
		logger.warning(
			f'Could not delete superseded storage file {remote_file_path}: {str(e)}',
			LogContext(category=LogCategory.SSH, token=token, dataset_id=dataset_id),
		)


def _is_uuid(value: str) -> bool:
	try:
		uuid.UUID(value)
	except ValueError:
		return False
	return True


@test_environment_only
def cleanup_storage_server_directory(directory_path: str, token: str):
	"""Clean up a directory on the storage server via SSH"""
	with create_verified_ssh_client(settings.SSH_KNOWN_HOSTS_PATH) as ssh:
		pkey = paramiko.Ed25519Key.from_private_key_file(settings.SSH_PRIVATE_KEY_PATH)

		try:
			ssh.connect(
				hostname=settings.STORAGE_SERVER_IP,
				username=settings.STORAGE_SERVER_USERNAME,
				pkey=pkey,
				port=2222,
			)

			# Execute rm command for all files in directory
			cmd = f'find {directory_path} -type f -delete'
			stdin, stdout, stderr = ssh.exec_command(cmd)
			error = stderr.read().decode().strip()

			if error:
				logger.error(f'Error cleaning up directory {directory_path}: {error}', extra={'token': token})
				raise Exception(f'Cleanup failed: {error}', operation='cleanup', file_path=directory_path)

			logger.info(f'Successfully cleaned up directory: {directory_path}', extra={'token': token})

		except Exception as e:
			logger.error(f'Failed to clean up directory {directory_path}: {str(e)}', extra={'token': token})
			raise Exception(f'Cleanup failed: {error}', operation='cleanup', file_path=directory_path)


def check_file_exists_on_storage(remote_file_path: str, token: str) -> bool:
	"""Check if a file exists on the storage server via SSH.

	Args:
		remote_file_path (str): Full path to the file on storage server
		token (str): Authentication token for logging

	Returns:
		bool: True if file exists, False otherwise
	"""
	with _storage_sftp(token, None) as sftp:
		try:
			sftp.stat(remote_file_path)
			logger.info(f'File exists on storage server: {remote_file_path}', extra={'token': token})
			return True
		except IOError:
			logger.info(f'File not found on storage server: {remote_file_path}', extra={'token': token})
			return False
