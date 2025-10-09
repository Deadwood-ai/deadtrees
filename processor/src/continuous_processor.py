import time
from processor.src.processor import background_process
from processor.src.utils.startup_cleanup import cleanup_orphaned_resources, cleanup_old_temp_directories
from shared.logger import logger
from shared.db import login
from shared.settings import settings


def run_continuous():
	"""Run the processor in a continuous loop, checking the queue every 10 seconds"""
	logger.info('Starting continuous processor...')

	# Perform startup cleanup to recover from crashes/restarts
	try:
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		logger.info('Running startup cleanup...')
		cleanup_orphaned_resources(token)
		cleanup_old_temp_directories(token)
	except Exception as e:
		logger.error(f'Startup cleanup failed (continuing anyway): {e}')

	while True:
		try:
			background_process()
		except Exception as e:
			logger.error(f'Error in processor loop: {e}')

		time.sleep(10)


if __name__ == '__main__':
	run_continuous()
