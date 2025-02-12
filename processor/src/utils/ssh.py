import os
import paramiko
from pathlib import Path
from datetime import datetime
from shared.logger import logger
from shared.settings import settings
from shared.models import StatusEnum
from shared.db import use_client


def pull_file_from_storage_server(remote_file_path: str, local_file_path: str, token: str):
	# Check if the file already exists locally
	if os.path.exists(local_file_path):
		logger.info(f'File already exists locally at: {local_file_path}')
		return

	with paramiko.SSHClient() as ssh:
		ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
		pkey = paramiko.RSAKey.from_private_key_file(
			settings.SSH_PRIVATE_KEY_PATH, password=settings.SSH_PRIVATE_KEY_PASSPHRASE
		)
		logger.info(
			f'Connecting to storage server: {settings.STORAGE_SERVER_IP} as {settings.STORAGE_SERVER_USERNAME}',
			extra={'token': token},
		)

		ssh.connect(
			hostname=settings.STORAGE_SERVER_IP,
			username=settings.STORAGE_SERVER_USERNAME,
			pkey=pkey,
			port=22,  # Add this line to specify the default SSH port
		)

		with ssh.open_sftp() as sftp:
			logger.info(
				f'Pulling file from storage server: {remote_file_path} to {local_file_path}', extra={'token': token}
			)

			# Create the directory for local_file_path if it doesn't exist
			local_dir = Path(local_file_path).parent
			local_dir.mkdir(parents=True, exist_ok=True)
			sftp.get(remote_file_path, local_file_path)

		# Check if the file exists after pulling
		if os.path.exists(local_file_path):
			logger.info(f'File successfully saved at: {local_file_path}', extra={'token': token})
		else:
			logger.error(f'Error: File not found at {local_file_path} after pulling', extra={'token': token})


def push_file_to_storage_server(local_file_path: str, remote_file_path: str, token: str):
	with paramiko.SSHClient() as ssh:
		ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
		pkey = paramiko.RSAKey.from_private_key_file(
			settings.SSH_PRIVATE_KEY_PATH, password=settings.SSH_PRIVATE_KEY_PASSPHRASE
		)
		logger.info(
			f'Connecting to storage server: {settings.STORAGE_SERVER_IP} as {settings.STORAGE_SERVER_USERNAME}',
			extra={'token': token},
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
					# If file exists on remote, use atomic rename approach
					logger.info('File exists on remote, using atomic rename approach', extra={'token': token})

					# Upload to temporary location first
					logger.info(f'Uploading file to temporary location: {temp_remote_path}', extra={'token': token})
					sftp.put(local_file_path, temp_remote_path)

					# Move existing file to trash directory with timestamp in the filename
					timestamp = datetime.now().strftime('%Y%m%d%H%M%S')
					trash_filename = f'{Path(remote_file_path).stem}_{timestamp}{Path(remote_file_path).suffix}'
					trash_path = settings.trash_path / trash_filename
					sftp.rename(remote_file_path, str(trash_path))
					logger.info(f'Moved existing file to trash: {trash_path}', extra={'token': token})

					# Atomic rename from temp to final location
					logger.info(f'Moving file to final location: {remote_file_path}', extra={'token': token})
					sftp.posix_rename(temp_remote_path, remote_file_path)
				else:
					# If file doesn't exist, directly upload to final location
					logger.info('File does not exist on remote, uploading directly', extra={'token': token})
					sftp.put(local_file_path, remote_file_path)

				logger.info(f'File successfully pushed to: {remote_file_path}', extra={'token': token})

			except Exception as e:
				# Clean up temp file if it exists
				try:
					sftp.remove(temp_remote_path)
					logger.info('Cleaned up temporary file after failure', extra={'token': token})
				except IOError:
					pass

				logger.error(f'Failed to push file to {remote_file_path}: {str(e)}', extra={'token': token})
				raise
