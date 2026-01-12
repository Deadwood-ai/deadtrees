#!/usr/bin/env python3
"""
Migration script: Move private COGs/thumbnails to UUID-prefixed paths.

This script migrates existing private datasets to use UUID-prefixed paths,
making their URLs unguessable and securing them against iteration attacks.

Usage:
    # Dry run (no changes made)
    python scripts/migrate_private_cogs_to_uuid.py --dry-run

    # Execute migration
    python scripts/migrate_private_cogs_to_uuid.py

    # Migrate specific dataset
    python scripts/migrate_private_cogs_to_uuid.py --dataset-id 1234

Prerequisites:
    - SSH access to storage server configured
    - Database credentials in environment
    - Run from project root with venv activated
"""







import argparse
import uuid
import sys
from pathlib import Path

import paramiko


# Add project root to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from shared.db import login, use_client
from shared.settings import settings
from shared.logger import logger







def get_private_datasets_needing_migration(token: str, dataset_id: int | None = None) -> list[dict]:
	"""Get all private datasets that need migration (no UUID in path)."""
	with use_client(token) as client:
		query = client.table('v2_datasets').select(
			'id, data_access, v2_cogs(cog_path, cog_file_name), v2_thumbnails(thumbnail_path, thumbnail_file_name)'
		).eq('data_access', 'private')

		if dataset_id:
			query = query.eq('id', dataset_id)

		response = query.execute()

		datasets_to_migrate = []
		for row in response.data:
			cog = row.get('v2_cogs')
			thumbnail = row.get('v2_thumbnails')

			# Skip if no COG
			if not cog or not cog.get('cog_path'):
				continue

			# Skip if already has UUID prefix (contains '/')
			if '/' in cog.get('cog_path', ''):
				continue

			datasets_to_migrate.append({
				'dataset_id': row['id'],
				'cog_path': cog.get('cog_path'),
				'cog_file_name': cog.get('cog_file_name'),
				'thumbnail_path': thumbnail.get('thumbnail_path') if thumbnail else None,
				'thumbnail_file_name': thumbnail.get('thumbnail_file_name') if thumbnail else None,
			})

		return datasets_to_migrate


def get_ssh_connection() -> paramiko.SSHClient:
	"""Create SSH connection to storage server."""
	ssh = paramiko.SSHClient()
	ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
	pkey = paramiko.Ed25519Key.from_private_key_file(settings.SSH_PRIVATE_KEY_PATH)

	ssh.connect(
		hostname=settings.STORAGE_SERVER_IP,
		username=settings.STORAGE_SERVER_USERNAME,
		pkey=pkey,
		port=22,  # Production port
	)
	return ssh


def migrate_file(sftp: paramiko.SFTPClient, base_dir: str, old_path: str, new_path: str, dry_run: bool) -> bool:
	"""Move a file from old path to new UUID-prefixed path."""
	old_full_path = f'{base_dir}/{old_path}'
	new_full_path = f'{base_dir}/{new_path}'
	new_dir = str(Path(new_full_path).parent)

	try:
		# Check if source exists
		try:
			sftp.stat(old_full_path)
		except IOError:
			logger.warning(f'Source file not found: {old_full_path}')
			return False

		if dry_run:
			logger.info(f'[DRY RUN] Would move: {old_full_path} -> {new_full_path}')
			return True

		# Create destination directory
		try:
			sftp.stat(new_dir)
		except IOError:
			sftp.mkdir(new_dir)
			logger.info(f'Created directory: {new_dir}')

		# Move file using rename (atomic on same filesystem)
		sftp.rename(old_full_path, new_full_path)
		logger.info(f'Moved: {old_full_path} -> {new_full_path}')
		return True

	except Exception as e:
		logger.error(f'Failed to migrate {old_full_path}: {e}')
		return False


def update_database(token: str, dataset_id: int, new_cog_path: str, new_thumbnail_path: str | None) -> bool:
	"""Update database with new paths."""
	try:
		with use_client(token) as client:
			# Update COG path
			client.table('v2_cogs').update({'cog_path': new_cog_path}).eq('dataset_id', dataset_id).execute()

			# Update thumbnail path if exists
			if new_thumbnail_path:
				client.table('v2_thumbnails').update({'thumbnail_path': new_thumbnail_path}).eq(
					'dataset_id', dataset_id
				).execute()

			logger.info(f'Updated database for dataset {dataset_id}')
			return True

	except Exception as e:
		logger.error(f'Failed to update database for dataset {dataset_id}: {e}')
		return False


def main():
	## ========================================================================
	## DEBUG MODE - Set these values for testing, then use argparse for prod
	## ========================================================================
	DEBUG_MODE = True  # Set to False to use command line args

	if DEBUG_MODE:
		# Hardcoded debug values
		dry_run = True  # Set to False to actually execute
		dataset_id = 3587  # Set to None to process all, or specific ID to test
	else:
		parser = argparse.ArgumentParser(description='Migrate private COGs/thumbnails to UUID-prefixed paths')
		parser.add_argument('--dry-run', action='store_true', help='Show what would be done without making changes')
		parser.add_argument('--dataset-id', type=int, help='Migrate only a specific dataset')
		args = parser.parse_args()
		dry_run = args.dry_run
		dataset_id = args.dataset_id
	## ========================================================================

	# Login
	logger.info('Logging in as processor...')
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

	# Get datasets needing migration
	logger.info('Fetching private datasets needing migration...')
	datasets = get_private_datasets_needing_migration(token, dataset_id)
	logger.info(f'Found {len(datasets)} datasets to migrate')

	if not datasets:
		logger.info('No datasets need migration.')
		return

	# Connect to storage server
	logger.info(f'Connecting to storage server {settings.STORAGE_SERVER_IP}...')
	ssh = get_ssh_connection()
	sftp = ssh.open_sftp()

	cog_base = f'{settings.STORAGE_SERVER_DATA_PATH}/cogs'
	thumbnail_base = f'{settings.STORAGE_SERVER_DATA_PATH}/thumbnails'

	# Migration stats
	success = 0
	failed = 0
	skipped = 0

	try:
		for i, dataset in enumerate(datasets, 1):
			dataset_id = dataset['dataset_id']
			logger.info(f'[{i}/{len(datasets)}] Processing dataset {dataset_id}...')

			# Generate UUID for this dataset
			secure_token = str(uuid.uuid4())

			# Build new paths
			new_cog_path = f'{secure_token}/{dataset["cog_file_name"]}'
			new_thumbnail_path = None
			if dataset['thumbnail_path'] and dataset['thumbnail_file_name']:
				new_thumbnail_path = f'{secure_token}/{dataset["thumbnail_file_name"]}'

			# Migrate COG
			cog_ok = migrate_file(sftp, cog_base, dataset['cog_path'], new_cog_path, dry_run)

			# Migrate thumbnail (if exists)
			if dataset['thumbnail_path']:
				migrate_file(sftp, thumbnail_base, dataset['thumbnail_path'], new_thumbnail_path, dry_run)

			if not cog_ok:
				skipped += 1
				continue

			# Update database (skip in dry run)
			if dry_run:
				logger.info(f'[DRY RUN] Would update DB: cog_path={new_cog_path}, thumbnail_path={new_thumbnail_path}')
				success += 1
			else:
				if update_database(token, dataset_id, new_cog_path, new_thumbnail_path):
					success += 1
				else:
					failed += 1

	finally:
		sftp.close()
		ssh.close()

	# Summary
	print('\n' + '=' * 50)
	print('MIGRATION SUMMARY')
	print('=' * 50)
	print(f'Total datasets:  {len(datasets)}')
	print(f'Successful:      {success}')
	print(f'Failed:          {failed}')
	print(f'Skipped:         {skipped}')

	if dry_run:
		print('\n[DRY RUN] No changes were made. Run without --dry-run to execute.')


if __name__ == '__main__':
	main()
