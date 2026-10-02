"""One lifecycle for every prepared download file (dataset ZIPs, label GeoPackages, bundles).

Files next to the final file ``<name>`` in the downloads directory:

- ``<name>.inflight``: created with O_EXCL by the one request that owns the build.
  The running job refreshes its mtime; a marker older than STALE_AFTER_SECONDS means
  the builder died (for example with the process) and the job may be restarted.
- ``<name>.error``: the failure message of the last build.
- ``.<name>.*.tmp/``: a private work directory per build; the result is moved into
  place with os.replace, so ``<name>`` is either absent or complete.
- ``<name>.manifest.json``: written after the file is in place. It names the export
  kind and every dataset in the file, and is bound to the file's identity, so a file
  without a matching manifest (unfinished, replaced or from before manifests) is
  never delivered. Delivery checks the requester against every listed dataset.

File names carry a content version. Once a build is in place, older versions of the
same file (``supersedes``) are deleted, so each variant keeps one copy on disk.
Readers that already opened an old file keep reading it.
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Callable, Iterator, Optional

from shared.logging import UnifiedLogger

logger = UnifiedLogger(__name__)

HEARTBEAT_SECONDS = 30
STALE_AFTER_SECONDS = 300
INTERRUPTED_MESSAGE = 'Download preparation was interrupted. Please request the download again.'


class ExportKind(str, Enum):
	DATASET = 'dataset'  # orthophotos, alone or in a multi-dataset bundle
	LABELS = 'labels'  # prediction and label GeoPackages


@dataclass(frozen=True)
class Manifest:
	kind: ExportKind
	dataset_ids: tuple[int, ...]


class JobState(str, Enum):
	COMPLETED = 'completed'
	PROCESSING = 'processing'
	FAILED = 'failed'
	MISSING = 'missing'


@dataclass(frozen=True)
class JobStatus:
	state: JobState
	message: str = ''


@dataclass(frozen=True)
class PreparedFileJob:
	path: Path
	# Names of older versions of this file, deleted once this build is in place.
	supersedes: Optional[re.Pattern] = field(default=None, compare=False)

	@property
	def error_path(self) -> Path:
		return self.path.with_name(f'{self.path.name}.error')

	@property
	def inflight_path(self) -> Path:
		return self.path.with_name(f'{self.path.name}.inflight')

	@property
	def manifest_path(self) -> Path:
		return self.path.with_name(f'{self.path.name}.manifest.json')

	def manifest(self) -> Optional[Manifest]:
		"""What the finished file contains, or None when it is missing, incomplete or unverified."""
		try:
			payload = json.loads(self.manifest_path.read_text(encoding='utf-8'))
			ids = tuple(payload['dataset_ids'])
			valid = (
				payload['version'] == 1
				and payload['file'] == _identity(self.path)
				and 0 < len(ids) <= 100
				and all(type(value) is int and value > 0 for value in ids)
			)
			return Manifest(ExportKind(payload['kind']), ids) if valid else None
		except (OSError, ValueError, KeyError, TypeError):
			return None

	def status(self) -> JobStatus:
		if self.manifest() is not None:
			return JobStatus(JobState.COMPLETED)
		age = self._inflight_age()
		if age is not None:
			if age <= STALE_AFTER_SECONDS:
				return JobStatus(JobState.PROCESSING)
			return JobStatus(JobState.FAILED, INTERRUPTED_MESSAGE)
		try:
			message = self.error_path.read_text(encoding='utf-8').strip()
		except FileNotFoundError:
			return JobStatus(JobState.MISSING)
		return JobStatus(JobState.FAILED, message or 'Download preparation failed')

	def claim(self) -> bool:
		"""Become the only builder of this file. False when a live build already owns it."""
		self.path.parent.mkdir(parents=True, exist_ok=True)
		with _directory_lock(self.path.parent):
			if self.manifest() is not None:
				return False
			age = self._inflight_age()
			if age is not None and age <= STALE_AFTER_SECONDS:
				return False
			self.inflight_path.unlink(missing_ok=True)
			fd = os.open(self.inflight_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
			with os.fdopen(fd, 'w') as marker:
				json.dump({'pid': os.getpid(), 'started_at': time.time()}, marker)
			self.error_path.unlink(missing_ok=True)
			self.path.unlink(missing_ok=True)  # a leftover without a manifest never counts as complete
			self.manifest_path.unlink(missing_ok=True)
		return True

	def run(self, build: Callable[[Path], object], manifest: Manifest) -> None:
		"""Build the file after a successful claim(). Never raises; failures go to the error marker."""
		stop = threading.Event()
		heartbeat = threading.Thread(target=self._heartbeat, args=(stop,), daemon=True)
		heartbeat.start()
		work_dir = None
		try:
			work_dir = Path(tempfile.mkdtemp(prefix=f'.{self.path.name}.', suffix='.tmp', dir=self.path.parent))
			target = work_dir / self.path.name
			build(target)
			if not _non_empty(target):
				raise ValueError('The prepared download file is empty')
			os.replace(target, self.path)
			self._write_manifest(manifest)
			logger.info(f'Prepared download file {self.path.name}')
			self._remove_superseded()
		except Exception as e:
			logger.error(f'Preparing download file {self.path.name} failed: {e}')
			self._write_error(str(e) or 'Download preparation failed')
		finally:
			stop.set()
			heartbeat.join()
			if work_dir is not None:
				shutil.rmtree(work_dir, ignore_errors=True)
			self.inflight_path.unlink(missing_ok=True)

	def _remove_superseded(self) -> None:
		if self.supersedes is None:
			return
		for sibling in self.path.parent.iterdir():
			if sibling.name != self.path.name and self.supersedes.fullmatch(sibling.name):
				sibling.unlink(missing_ok=True)
				sibling.with_name(f'{sibling.name}.error').unlink(missing_ok=True)
				sibling.with_name(f'{sibling.name}.manifest.json').unlink(missing_ok=True)
				logger.info(f'Removed superseded download file {sibling.name}')

	def _inflight_age(self) -> float | None:
		try:
			return time.time() - self.inflight_path.stat().st_mtime
		except FileNotFoundError:
			return None

	def _heartbeat(self, stop: threading.Event) -> None:
		while not stop.wait(HEARTBEAT_SECONDS):
			try:
				os.utime(self.inflight_path)
			except FileNotFoundError:
				return

	def _write_manifest(self, manifest: Manifest) -> None:
		payload = {
			'version': 1,
			'kind': manifest.kind.value,
			'dataset_ids': sorted(set(manifest.dataset_ids)),
			'file': _identity(self.path),
		}
		fd, temp_name = tempfile.mkstemp(prefix=f'.{self.manifest_path.name}.', dir=self.path.parent)
		with os.fdopen(fd, 'w', encoding='utf-8') as handle:
			json.dump(payload, handle)
		os.replace(temp_name, self.manifest_path)

	def _write_error(self, message: str) -> None:
		fd, temp_name = tempfile.mkstemp(prefix=f'.{self.error_path.name}.', dir=self.path.parent)
		with os.fdopen(fd, 'w', encoding='utf-8') as handle:
			handle.write(message)
		os.replace(temp_name, self.error_path)


def _identity(path: Path) -> list[int]:
	stat = path.stat()
	return [stat.st_ino, stat.st_size, stat.st_mtime_ns]


def _non_empty(path: Path) -> bool:
	try:
		return path.stat().st_size > 0
	except FileNotFoundError:
		return False


@contextmanager
def _directory_lock(directory: Path) -> Iterator[None]:
	"""Serialize claims across threads and worker processes that share the directory."""
	fd = os.open(directory, os.O_RDONLY)
	try:
		fcntl.flock(fd, fcntl.LOCK_EX)
		yield
	finally:
		os.close(fd)
