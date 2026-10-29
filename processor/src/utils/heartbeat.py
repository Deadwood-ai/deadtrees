"""Processor heartbeat: tells the database this worker is alive, also while it runs a task.

release_stale_queue_claim (DT-1471) frees a claim only when its worker's heartbeat
is stale, so the heartbeat must keep ticking through long ODM and model stages.
It runs in a daemon thread and never blocks processing; login() reuses the
cached processor session until it is close to expiry.
"""

import threading
from datetime import datetime, timezone

from shared.__version__ import __version__
from shared.db import login, use_client
from shared.logging import UnifiedLogger
from shared.settings import settings

logger = UnifiedLogger(__name__)

HEARTBEAT_INTERVAL_SECONDS = 60


def record_heartbeat(token: str, worker_id: str) -> None:
	with use_client(token) as client:
		client.table(settings.processor_heartbeats_table).upsert(
			{'worker_id': worker_id, 'seen_at': datetime.now(timezone.utc).isoformat(), 'backend_version': __version__},
			on_conflict='worker_id',
		).execute()


def run_heartbeat(worker_id: str, stop: threading.Event) -> None:
	"""Write a heartbeat every minute until stop is set; a failed write is logged and retried."""
	while not stop.is_set():
		try:
			record_heartbeat(login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD), worker_id)
		except Exception as e:
			logger.warning(f'Could not record processor heartbeat: {e}')
		stop.wait(HEARTBEAT_INTERVAL_SECONDS)


def start_heartbeat(worker_id: str) -> threading.Event:
	"""Start the heartbeat thread; set the returned event to stop it."""
	stop = threading.Event()
	threading.Thread(target=run_heartbeat, args=(worker_id, stop), name='processor-heartbeat', daemon=True).start()
	return stop
