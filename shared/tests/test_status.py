from datetime import datetime

from shared.models import StatusEnum
from shared.status import update_status


def test_update_status_refreshes_updated_at(monkeypatch):
	updates = []
	inserts = []

	class _ExecuteResult:
		data = [{'id': 1}]

	class _EqQuery:
		def __init__(self, payload=None):
			self.payload = payload

		def eq(self, field, value):
			assert field == 'dataset_id'
			assert value == 123
			return self

		def execute(self):
			return _ExecuteResult()

	class _Table:
		def select(self, fields):
			assert fields == 'id'
			return _EqQuery()

		def update(self, payload):
			updates.append(payload)
			return _EqQuery(payload)

		def insert(self, payload):
			inserts.append(payload)
			return _EqQuery(payload)

	class _Client:
		def table(self, name):
			assert name == 'v2_statuses'
			return _Table()

		def __enter__(self):
			return self

		def __exit__(self, exc_type, exc, tb):
			return False

	monkeypatch.setattr('shared.status.use_client', lambda token: _Client())

	update_status('token', dataset_id=123, current_status=StatusEnum.ortho_processing)

	assert inserts == []
	assert len(updates) == 1
	assert updates[0]['current_status'] == StatusEnum.ortho_processing
	updated_at = datetime.fromisoformat(updates[0]['updated_at'])
	assert updated_at.tzinfo is not None


def test_update_status_sets_updated_at_when_creating_status(monkeypatch):
	inserts = []

	class _EmptyResult:
		data = []

	class _EqQuery:
		def eq(self, field, value):
			assert field == 'dataset_id'
			assert value == 123
			return self

		def execute(self):
			return _EmptyResult()

	class _InsertQuery:
		def execute(self):
			return None

	class _Table:
		def select(self, fields):
			assert fields == 'id'
			return _EqQuery()

		def insert(self, payload):
			inserts.append(payload)
			return _InsertQuery()

	class _Client:
		def table(self, name):
			assert name == 'v2_statuses'
			return _Table()

		def __enter__(self):
			return self

		def __exit__(self, exc_type, exc, tb):
			return False

	monkeypatch.setattr('shared.status.use_client', lambda token: _Client())

	update_status('token', dataset_id=123, is_upload_done=True)

	assert len(inserts) == 1
	assert inserts[0]['dataset_id'] == 123
	assert inserts[0]['is_upload_done'] is True
	updated_at = datetime.fromisoformat(inserts[0]['updated_at'])
	assert updated_at.tzinfo is not None
