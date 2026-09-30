"""Network-free fakes for the FreiDATA publisher tests."""
from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest

from freidata.config import load_config


class FakeQuery:
	"""The subset of the supabase-py query builder that freidata uses."""

	def __init__(self, rows: List[Dict[str, Any]]):
		self._rows = rows
		self._filters = []
		self._update = None

	def select(self, *_columns):
		return self

	def update(self, fields):
		self._update = fields
		return self

	def eq(self, column, value):
		self._filters.append(lambda row: row.get(column) == value)
		return self

	def limit(self, _count):
		return self

	def execute(self):
		matched = [row for row in self._rows if all(f(row) for f in self._filters)]
		if self._update is not None:
			for row in matched:
				row.update(self._update)
		return SimpleNamespace(data=[dict(row) for row in matched])


class FakeDB:
	def __init__(self, publications: List[Dict[str, Any]]):
		self.publications = publications
		self.full_info: Dict[int, Dict[str, Any]] = {}

	def table(self, name):
		if name == 'data_publication':
			return FakeQuery(self.publications)
		if name == 'data_publication_full_info':
			return FakeQuery(list(self.full_info.values()))
		raise AssertionError(f'unexpected table {name}')


@pytest.fixture
def cfg(monkeypatch, tmp_path):
	for name in ('ZULIP_EMAIL', 'ZULIP_API_KEY', 'ZULIP_SITE', 'FREIDATA_TOKEN', 'STOP_AFTER', 'FREIDATA_STALE_UPLOAD_HOURS'):
		monkeypatch.delenv(name, raising=False)
	return replace(load_config(), log_file=str(tmp_path / 'freidata.log'))


@pytest.fixture
def notifications(monkeypatch):
	"""Error notifications that would go to Zulip."""
	sent = []

	def record(cfg, **fields):
		sent.append(fields)
		return True

	monkeypatch.setattr('freidata.pipeline.notify_error', record)
	monkeypatch.setattr('freidata.cron.notify_error', record)
	return sent
