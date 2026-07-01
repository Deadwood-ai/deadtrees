import time
from processor.src.processor import background_process
from processor.src.utils.startup_cleanup import cleanup_orphaned_resources, cleanup_old_temp_directories
from shared.logger import logger
from shared.db import login
from shared.settings import settings


def run_continuous():
	"""Run the processor as a persistent worker.

	The worker drains the queue back-to-back: as long as ``background_process``
	reports it processed a task, the next one is claimed immediately with no
	wait. Only when the queue has nothing processable does the worker sleep for
	``PROCESSOR_IDLE_BACKOFF_SECONDS`` before polling again. This replaces the
	old one-task-per-cron-run model, where every task paid the wait for the next
	cron minute plus container startup, login and cleanup overhead.
	"""
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
			did_work = background_process()
		except Exception as e:
			logger.error(f'Error in processor loop: {e}')
			did_work = False

		# Back off only when there was nothing to do; while a backlog exists we
		# loop straight into the next claim so no task waits on a fixed timer.
		if not did_work:
			time.sleep(settings.PROCESSOR_IDLE_BACKOFF_SECONDS)


if __name__ == '__main__':
	run_continuous()
