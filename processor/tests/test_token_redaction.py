"""Processor bearer tokens must never reach error messages, logs or Linear."""
import logging

import pytest

from processor.src.exceptions import AuthenticationError
from processor.src.utils import linear_issues
from shared import logging as shared_logging
from shared import status as shared_status
from shared.redaction import REDACTED_TOKEN, redact_tokens

pytestmark = pytest.mark.unit

TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcm9jZXNzb3IifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ'


def test_authentication_error_message_has_no_token():
	error = AuthenticationError('Token refresh failed', task_id=7)

	assert str(error) == 'Token refresh failed'
	assert error.task_id == 7


def test_redact_tokens_replaces_jwts_and_keeps_other_text():
	text = f'Invalid processor token (token: {TOKEN}) for dataset 12'

	assert redact_tokens(text) == f'Invalid processor token (token: {REDACTED_TOKEN}) for dataset 12'
	assert redact_tokens('COG failed: disk full') == 'COG failed: disk full'


def test_linear_issue_description_redacts_error_and_logs():
	description = linear_issues.build_issue_description(
		dataset_id=12,
		stage='cog',
		error_message=f'Token refresh failed (token: {TOKEN})',
		context={},
		logs=[f'retrying with {TOKEN}'],
	)

	assert TOKEN not in description
	assert description.count(REDACTED_TOKEN) == 2


def test_status_error_message_is_redacted(monkeypatch):
	updates = []

	class _Query:
		def __init__(self, data=None):
			self.data = data

		def eq(self, *_):
			return self

		def execute(self):
			return self

	class _Table:
		def select(self, _):
			return _Query([{'id': 1}])

		def update(self, payload):
			updates.append(payload)
			return _Query()

	class _Client:
		def table(self, _):
			return _Table()

		def __enter__(self):
			return self

		def __exit__(self, *_):
			return False

	monkeypatch.setattr(shared_status, 'use_client', lambda token: _Client())

	shared_status.update_status('token', dataset_id=12, has_error=True, error_message=f'failed (token: {TOKEN})')

	assert updates[0]['error_message'] == f'failed (token: {REDACTED_TOKEN})'


def test_database_log_message_is_redacted():
	inserted = []

	class _Table:
		def insert(self, entry, returning=None):
			inserted.append(entry)
			return self

		def execute(self):
			return None

	class _Client:
		def table(self, _):
			return _Table()

		def __enter__(self):
			return self

		def __exit__(self, *_):
			return False

	handler = shared_logging.SupabaseHandler()
	handler.use_client = lambda: _Client()
	record = logging.LogRecord('processor', logging.ERROR, __file__, 1, f'failed with {TOKEN}', None, None)
	record.extra = {'error': f'token: {TOKEN}', 'attempt': 2}
	handler.emit(record)

	assert inserted[0]['message'] == f'failed with {REDACTED_TOKEN}'
	assert inserted[0]['extra'] == {'error': f'token: {REDACTED_TOKEN}', 'attempt': 2}
