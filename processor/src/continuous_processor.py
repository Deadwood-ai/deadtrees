import time
from processor.src.processor import background_process
from processor.src.utils.drain_control import (
	BackgroundProcessResult,
	is_drain_requested,
)
from processor.src.utils.startup_cleanup import cleanup_orphaned_resources, cleanup_old_temp_directories
from shared.logger import logger
from shared.db import login
from shared.settings import settings


def run_continuous():
	"""Run the processor as a persistent worker until it is stopped."""
	logger.info('Starting continuous processor...')

	# Perform startup cleanup to recover from crashes/restarts
	try:
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		logger.info('Running startup cleanup...')
		cleanup_orphaned_resources(token)
		cleanup_old_temp_directories(token)
	except Exception as e:
		logger.error(f'Startup cleanup failed (continuing anyway): {e}')

	drain_logged = False
	consecutive_loop_failures = 0

	while True:
		drain_requested = is_drain_requested()
		if drain_requested and not drain_logged:
			logger.info('Processor drain requested; holding new queue claims until the control file is cleared')
			drain_logged = True
		elif not drain_requested and drain_logged:
			logger.info('Processor drain cleared; resuming queue polling')
			drain_logged = False

		try:
			result = background_process()
		except Exception:
			consecutive_loop_failures += 1
			logger.exception('Error in processor loop')
			if consecutive_loop_failures >= settings.PROCESSOR_LOOP_FAILURE_LIMIT:
				logger.error(
					f'Processor loop failed {consecutive_loop_failures} consecutive times; exiting for supervised restart'
				)
				raise
			result = BackgroundProcessResult.FAILED
		else:
			consecutive_loop_failures = 0

		if result is not BackgroundProcessResult.WORKED:
			time.sleep(settings.PROCESSOR_IDLE_BACKOFF_SECONDS)


if __name__ == '__main__':
	run_continuous()
