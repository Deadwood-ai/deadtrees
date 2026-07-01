"""Unit tests for the persistent-worker loop in continuous_processor.

These exercise the drain-vs-backoff decision without touching the real queue:
``background_process`` and ``time.sleep`` are stubbed so we can assert exactly
when the worker sleeps.
"""

import pytest

import processor.src.continuous_processor as cp


def _disable_startup(monkeypatch):
	"""Stub out login + cleanup so run_continuous goes straight to the loop."""
	monkeypatch.setattr(cp, 'login', lambda *a, **k: 'token')
	monkeypatch.setattr(cp, 'cleanup_orphaned_resources', lambda *a, **k: None)
	monkeypatch.setattr(cp, 'cleanup_old_temp_directories', lambda *a, **k: None)


def _run_loop(monkeypatch, work_sequence):
	"""Drive run_continuous over a fixed sequence, recording sleeps.

	A trailing KeyboardInterrupt (BaseException, so not swallowed by the loop's
	``except Exception``) breaks out of the otherwise-infinite ``while True``.
	Returns the list of arguments passed to time.sleep.
	"""
	_disable_startup(monkeypatch)

	sleeps = []
	monkeypatch.setattr(cp.time, 'sleep', lambda s: sleeps.append(s))

	seq = list(work_sequence)

	def fake_background_process():
		if not seq:
			raise KeyboardInterrupt
		item = seq.pop(0)
		if isinstance(item, type) and issubclass(item, BaseException):
			raise item
		return item

	monkeypatch.setattr(cp, 'background_process', fake_background_process)

	with pytest.raises(KeyboardInterrupt):
		cp.run_continuous()
	return sleeps


def test_backlog_drains_without_sleeping(monkeypatch):
	"""Consecutive processed tasks must claim the next one with no wait."""
	sleeps = _run_loop(monkeypatch, [True, True, True])
	assert sleeps == []


def test_idle_poll_backs_off(monkeypatch):
	"""An empty poll sleeps for the configured idle backoff."""
	monkeypatch.setattr(cp.settings, 'PROCESSOR_IDLE_BACKOFF_SECONDS', 7)
	sleeps = _run_loop(monkeypatch, [False])
	assert sleeps == [7]


def test_only_idle_polls_sleep(monkeypatch):
	"""Work then idle then work: exactly one sleep, only for the idle poll."""
	monkeypatch.setattr(cp.settings, 'PROCESSOR_IDLE_BACKOFF_SECONDS', 5)
	sleeps = _run_loop(monkeypatch, [True, False, True])
	assert sleeps == [5]


def test_exception_is_treated_as_idle(monkeypatch):
	"""A crashing poll is caught and backs off instead of hot-looping."""
	monkeypatch.setattr(cp.settings, 'PROCESSOR_IDLE_BACKOFF_SECONDS', 3)
	sleeps = _run_loop(monkeypatch, [RuntimeError])
	assert sleeps == [3]
