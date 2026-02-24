"""
Startup cleanup utilities for processor.

This module provides functions to clean up orphaned resources on processor startup,
including zombie extract containers and stuck queue items. This is critical for
recovering from processor crashes or restarts.
"""

import docker
import time
from datetime import datetime, timezone
from shared.logger import logger
from shared.logging import LogContext, LogCategory
from processor.src.utils.debug_artifacts import retention_ttl_hours


def cleanup_orphaned_resources(token: str):
	"""
	Clean up zombie containers and orphaned volumes on processor startup.

	This function:
	1. Removes old extract containers (Alpine containers stuck with tail -f)
	2. Removes orphaned Docker volumes (optional)

	Note: Stuck queue items (previously is_processing=True) are now handled by
	crash detection in background_process() which checks current_status in v2_statuses.

	Args:
		token: Authentication token for database operations
	"""
	client = docker.from_env()
	ttl_hours = retention_ttl_hours()

	logger.info('=== STARTUP CLEANUP ===', LogContext(category=LogCategory.PROCESS, token=token))

	# 0. Clean up retained artifacts past TTL (containers/volumes kept for debugging)
	try:
		retained = client.containers.list(all=True, filters={'label': 'dt_keep=true'})
		if retained:
			logger.info(
				f'Found {len(retained)} retained containers (dt_keep=true), TTL={ttl_hours}h',
				LogContext(category=LogCategory.PROCESS, token=token),
			)

		removed_retained = 0
		for container in retained:
			try:
				created_timestamp = container.attrs.get('Created') if hasattr(container, 'attrs') else None
				if not created_timestamp:
					container.reload()
					created_timestamp = container.attrs.get('Created')
				created_time = datetime.fromisoformat(created_timestamp.replace('Z', '+00:00'))
				age_hours = (datetime.now(timezone.utc) - created_time).total_seconds() / 3600

				if age_hours > ttl_hours:
					logger.warning(
						f'Removing retained container past TTL: {container.name} (age: {age_hours:.1f}h)',
						LogContext(category=LogCategory.PROCESS, token=token),
					)
					container.remove(force=True)
					removed_retained += 1
			except Exception as e:
				logger.warning(
					f'Failed to evaluate/remove retained container {getattr(container, "name", "?")}: {e}',
					LogContext(category=LogCategory.PROCESS, token=token),
				)

		if removed_retained > 0:
			logger.info(
				f'Removed {removed_retained} retained containers past TTL',
				LogContext(category=LogCategory.PROCESS, token=token),
			)
	except Exception as e:
		logger.warning(
			f'Failed retained container cleanup: {e}',
			LogContext(category=LogCategory.PROCESS, token=token),
		)

	# 1. Find and kill zombie extract containers
	try:
		zombies = client.containers.list(all=True, filters={'label': 'dt_role=temp_extract'})
		logger.info(
			f'Found {len(zombies)} zombie extract containers', LogContext(category=LogCategory.PROCESS, token=token)
		)

		removed_count = 0
		for container in zombies:
			try:
				# Check age - if older than 2 hours, definitely a zombie
				created_timestamp = container.attrs['Created']
				created_time = datetime.fromisoformat(created_timestamp.replace('Z', '+00:00'))
				age_hours = (datetime.now(timezone.utc) - created_time).total_seconds() / 3600

				if age_hours > 2:
					logger.warning(
						f'Killing zombie: {container.name} (age: {age_hours:.1f}h)',
						LogContext(category=LogCategory.PROCESS, token=token),
					)
					container.remove(force=True)
					removed_count += 1
			except Exception as e:
				logger.error(
					f'Failed to remove {container.name}: {e}', LogContext(category=LogCategory.PROCESS, token=token)
				)

		if removed_count > 0:
			logger.info(
				f'Removed {removed_count} zombie extract containers',
				LogContext(category=LogCategory.PROCESS, token=token),
			)
	except Exception as e:
		logger.error(f'Failed to cleanup zombie containers: {e}', LogContext(category=LogCategory.PROCESS, token=token))

	# 1b. Clean up exited stage containers leaked by crashes (ODM/TCD)
	# Note: ODM is run with remove=False for better failure forensics. If the processor
	# crashes mid-flight, exited containers can be left behind.
	try:
		roles = ('odm_container', 'tcd_pipeline')
		removed_stage = 0
		for role in roles:
			containers = client.containers.list(all=True, filters={'label': f'dt_role={role}'})
			for c in containers:
				try:
					c.reload()
					status = getattr(c, 'status', '') or ''
					if status == 'running':
						continue

					created_timestamp = c.attrs.get('Created', '')
					if not created_timestamp:
						continue

					created_time = datetime.fromisoformat(created_timestamp.replace('Z', '+00:00'))
					age_hours = (datetime.now(timezone.utc) - created_time).total_seconds() / 3600
					if age_hours > ttl_hours:
						logger.warning(
							f'Removing leaked stage container: {c.name} (role={role}, age: {age_hours:.1f}h, status={status})',
							LogContext(category=LogCategory.PROCESS, token=token),
						)
						c.remove(force=True)
						removed_stage += 1
				except Exception:
					pass

		if removed_stage > 0:
			logger.info(
				f'Removed {removed_stage} leaked stage containers (older than {ttl_hours}h)',
				LogContext(category=LogCategory.PROCESS, token=token),
			)
	except Exception as e:
		logger.warning(
			f'Failed leaked stage container cleanup: {e}',
			LogContext(category=LogCategory.PROCESS, token=token),
		)

	# 2. Clean up orphaned volumes (optional - only if not referenced)
	try:
		orphaned_volumes = []
		for prefix in ('odm_processing_', 'tcd_volume_'):
			volumes = client.volumes.list(filters={'name': prefix})
			for volume in volumes:
				try:
					# Check if volume is referenced by any container
					containers = client.containers.list(all=True, filters={'volume': volume.name})
					if containers:
						continue

					volume.reload()
					created_at = volume.attrs.get('CreatedAt', '')
					if not created_at:
						continue

					created_time = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
					age_hours = (datetime.now(timezone.utc) - created_time).total_seconds() / 3600

					# Remove volumes older than TTL; these are usually leaked from crashes.
					if age_hours > ttl_hours:
						orphaned_volumes.append((volume, age_hours))
				except Exception:
					pass  # Skip volumes we can't inspect

		if orphaned_volumes:
			logger.info(
				f'Found {len(orphaned_volumes)} orphaned volumes (>{ttl_hours}h old)',
				LogContext(category=LogCategory.PROCESS, token=token),
			)

			for volume, age_hours in orphaned_volumes:
				try:
					logger.warning(
						f'Removing orphaned volume: {volume.name} (age: {age_hours:.1f}h)',
						LogContext(category=LogCategory.PROCESS, token=token),
					)
					volume.remove(force=True)
				except Exception as e:
					logger.error(
						f'Failed to remove volume {volume.name}: {e}',
						LogContext(category=LogCategory.PROCESS, token=token),
					)
	except Exception as e:
		logger.error(f'Failed to cleanup orphaned volumes: {e}', LogContext(category=LogCategory.PROCESS, token=token))

	logger.info('=== CLEANUP COMPLETE ===', LogContext(category=LogCategory.PROCESS, token=token))


def cleanup_old_temp_directories(token: str):
	"""
	Clean up old temporary directories left over from processing.

	This removes temp directories older than 24 hours to prevent disk space issues.

	Args:
		token: Authentication token for logging
	"""
	import os
	import shutil
	from pathlib import Path

	try:
		# Check common temp locations
		temp_patterns = [
			'/app/processor/temp/odm_temp_*',
			'/app/processor/temp/treecover_*',
		]

		cleaned_count = 0
		for pattern in temp_patterns:
			base_dir = Path(pattern).parent
			if not base_dir.exists():
				continue

			pattern_name = Path(pattern).name
			for temp_dir in base_dir.glob(pattern_name):
				try:
					# Check age
					stat = temp_dir.stat()
					age_hours = (time.time() - stat.st_mtime) / 3600

					if age_hours > 24:
						logger.info(
							f'Removing old temp directory: {temp_dir} (age: {age_hours:.1f}h)',
							LogContext(category=LogCategory.PROCESS, token=token),
						)
						shutil.rmtree(temp_dir)
						cleaned_count += 1
				except Exception as e:
					logger.error(
						f'Failed to remove temp directory {temp_dir}: {e}',
						LogContext(category=LogCategory.PROCESS, token=token),
					)

		if cleaned_count > 0:
			logger.info(
				f'Removed {cleaned_count} old temp directories', LogContext(category=LogCategory.PROCESS, token=token)
			)
	except Exception as e:
		logger.error(f'Failed to cleanup temp directories: {e}', LogContext(category=LogCategory.PROCESS, token=token))
