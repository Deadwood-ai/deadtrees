import os
import paramiko
from pathlib import Path
from datetime import datetime
from shared.logger import logger
from shared.settings import settings

from shared.logging import LogContext, LogCategory


def pull_file_from_storage_server(remote_file_path: str, local_file_path: str, token: str, dataset_id: int):
	# Check if the file already exists locally
	if os.path.exists(local_file_path):
		logger.info(
			f'File already exists locally at: {local_file_path}',
			LogContext(category=LogCategory.SSH, token=token, dataset_id=dataset_id),
		)
		return

	with paramiko.SSHClient() as ssh:
		ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
		pkey = paramiko.Ed25519Key.from_private_key_file(settings.SSH_PRIVATE_KEY_PATH)
		logger.info(
			f'Connecting to storage server: {settings.STORAGE_SERVER_IP} as {settings.STORAGE_SERVER_USERNAME}',
			LogContext(category=LogCategory.SSH, token=token, dataset_id=dataset_id),
		)

		ssh.connect(
			hostname=settings.STORAGE_SERVER_IP,
			username=settings.STORAGE_SERVER_USERNAME,
			pkey=pkey,
			port=22,  # Add this line to specify the default SSH port
		)

		with ssh.open_sftp() as sftp:
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
			sftp.get(remote_file_path, local_file_path)

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


def push_file_to_storage_server(local_file_path: str, remote_file_path: str, token: str, dataset_id: int):
	with paramiko.SSHClient() as ssh:
		ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
		pkey = paramiko.Ed25519Key.from_private_key_file(settings.SSH_PRIVATE_KEY_PATH)
		logger.info(
			f'Connecting to storage server: {settings.STORAGE_SERVER_IP} as {settings.STORAGE_SERVER_USERNAME}',
			LogContext(category=LogCategory.SSH, token=token, dataset_id=dataset_id),
		)
		ssh.connect(
			hostname=settings.STORAGE_SERVER_IP,
			username=settings.STORAGE_SERVER_USERNAME,
			pkey=pkey,
			port=22,
		)

		with ssh.open_sftp() as sftp:
			temp_remote_path = f'{remote_file_path}.tmp'

			try:
				# Check if file exists on remote host
				try:
					sftp.stat(remote_file_path)
					file_exists = True
				except IOError:
					file_exists = False

				if file_exists:
					logger.info(
						'File exists on remote, using atomic rename approach',
						LogContext(
							category=LogCategory.SSH,
							token=token,
							dataset_id=dataset_id,
							extra={'remote_path': remote_file_path},
						),
					)

					# Upload to temporary location first
					logger.info(
						'Uploading file to temporary location',
						LogContext(
							category=LogCategory.SSH,
							token=token,
							dataset_id=dataset_id,
							extra={'temp_path': temp_remote_path},
						),
					)
					sftp.put(local_file_path, temp_remote_path)

					# Move existing file to trash directory with timestamp
					timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
					trash_filename = f'{Path(remote_file_path).stem}_{timestamp}{Path(remote_file_path).suffix}'
					trash_path = settings.trash_path / trash_filename
					sftp.rename(remote_file_path, str(trash_path))
					logger.info(
						'Moved existing file to trash',
						LogContext(
							category=LogCategory.SSH,
							token=token,
							dataset_id=dataset_id,
							extra={'original_path': remote_file_path, 'trash_path': str(trash_path)},
						),
					)

					# Atomic rename from temp to final location
					logger.info(
						'Moving file to final location',
						LogContext(
							category=LogCategory.SSH,
							token=token,
							dataset_id=dataset_id,
							extra={'from_path': temp_remote_path, 'to_path': remote_file_path},
						),
					)
					sftp.posix_rename(temp_remote_path, remote_file_path)
				else:
					logger.info(
						'File does not exist on remote, uploading directly',
						LogContext(
							category=LogCategory.SSH,
							token=token,
							dataset_id=dataset_id,
							extra={'remote_path': remote_file_path},
						),
					)
					sftp.put(local_file_path, remote_file_path)

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
				# Clean up temp file if it exists
				try:
					sftp.remove(temp_remote_path)
					logger.info(
						'Cleaned up temporary file after failure',
						LogContext(
							category=LogCategory.SSH,
							token=token,
							dataset_id=dataset_id,
							extra={'temp_path': temp_remote_path},
						),
					)
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


def cleanup_storage_server_directory(directory_path: str, token: str):
	"""Clean up a directory on the storage server via SSH"""
	with paramiko.SSHClient() as ssh:
		ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
		pkey = paramiko.Ed25519Key.from_private_key_file(settings.SSH_PRIVATE_KEY_PATH)

		try:
			ssh.connect(
				hostname=settings.STORAGE_SERVER_IP,
				username=settings.STORAGE_SERVER_USERNAME,
				pkey=pkey,
				port=22,
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
	with paramiko.SSHClient() as ssh:
		ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
		pkey = paramiko.Ed25519Key.from_private_key_file(settings.SSH_PRIVATE_KEY_PATH)

		ssh.connect(
			hostname=settings.STORAGE_SERVER_IP,
			username=settings.STORAGE_SERVER_USERNAME,
			pkey=pkey,
			port=22,
		)

		with ssh.open_sftp() as sftp:
			try:
				sftp.stat(remote_file_path)
				logger.info(f'File exists on storage server: {remote_file_path}', extra={'token': token})
				return True
			except IOError:
				logger.info(f'File not found on storage server: {remote_file_path}', extra={'token': token})
				return False
