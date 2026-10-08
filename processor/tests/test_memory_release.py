"""Returning freed heap memory to the host between tasks."""

import pytest

from processor.src.utils import memory_release

pytestmark = pytest.mark.unit


def test_release_reports_resident_memory_and_trims(monkeypatch):
	trimmed = []

	class FakeLibc:
		def malloc_trim(self, pad):
			trimmed.append(pad)

	monkeypatch.setattr(memory_release.ctypes, 'CDLL', lambda name: FakeLibc())

	before, after = memory_release.release_process_memory()

	assert trimmed == [0]
	assert before is not None and before > 0
	assert after is not None and after > 0


def test_release_survives_a_libc_without_malloc_trim(monkeypatch):
	def missing(name):
		raise OSError(name)

	monkeypatch.setattr(memory_release.ctypes, 'CDLL', missing)

	assert memory_release.release_process_memory()[0] is not None
