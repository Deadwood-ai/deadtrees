from pathlib import Path
import time
from shared.settings import settings
import logging
from shared.testing.safety import test_environment_only

logger = logging.getLogger(__name__)

# this is a background task that runs every hour
# it removes files older than 1 hour from the downloads directory
# it is scheduled in the download router


@test_environment_only
def cleanup_downloads_directory(max_age_hours: int = 1):
	"""Remove files older than max_age_hours from downloads directory"""
	downloads_dir = settings.downloads_path
	current_time = time.time()

	# First pass: remove old files
	for item in downloads_dir.glob('**/*'):
		if item.is_file():
			file_age = current_time - item.stat().st_mtime
			if file_age > (max_age_hours * 3600):
				try:
					item.unlink()
					logger.info(f'Removed old download file: {item}')
				except Exception as e:
					logger.error(f'Failed to remove old download file {item}: {e}')

	# Second pass: remove empty directories
	for item in downloads_dir.glob('**/*'):
		if item.is_dir():
			try:
				item.rmdir()  # Only removes if directory is empty
				logger.info(f'Removed empty directory: {item}')
			except OSError:
				pass  # Directory not empty, skip
