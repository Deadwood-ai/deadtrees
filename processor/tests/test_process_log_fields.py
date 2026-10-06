import logging

import pytest

from shared import logging as shared_logging

pytestmark = pytest.mark.unit


class _Client:
	def __init__(self, inserted):
		self.inserted = inserted

	def table(self, _):
		return self

	def insert(self, entry, returning=None):
		self.inserted.append(entry)
		return self

	def execute(self):
		return None

	def __enter__(self):
		return self

	def __exit__(self, *_):
		return False


def _emit(extra):
	inserted = []
	handler = shared_logging.SupabaseHandler()
	handler.use_client = lambda: _Client(inserted)
	record = logging.LogRecord('processor', logging.INFO, __file__, 1, 'message', None, None)
	if extra is not None:
		record.extra = extra
	handler.emit(record)
	return inserted[0]['extra']


def test_process_log_fields_tag_every_row_and_yield_to_explicit_fields():
	assert _emit(None) is None

	shared_logging.set_process_log_fields(worker_id='host-abc')

	assert _emit(None) == {'worker_id': 'host-abc'}
	assert _emit({'event': 'task_started'}) == {'worker_id': 'host-abc', 'event': 'task_started'}
	assert _emit({'worker_id': 'explicit'}) == {'worker_id': 'explicit'}
