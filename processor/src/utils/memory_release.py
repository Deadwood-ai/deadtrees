"""Give freed heap memory back to the host between tasks.

The processor is a long-running Python process with many native threads (GDAL,
rasterio, torch). glibc keeps freed memory in per-thread arenas, so after large
tasks the process can sit on tens of GB it no longer uses. ODM runs in a sibling
container on the same host; when the processor holds that memory, the host runs
out and the kernel kills ODM (datasets 14778 and 14831, 2026-10-08; DT-1376).
"""

import ctypes
import gc
from pathlib import Path


def _rss_gb() -> float | None:
	try:
		for line in Path('/proc/self/status').read_text().splitlines():
			if line.startswith('VmRSS:'):
				return int(line.split()[1]) / 1024 / 1024
	except OSError:
		pass
	return None


def release_process_memory() -> tuple[float | None, float | None]:
	"""Collect garbage and return free heap pages to the OS; report resident memory before and after, in GB."""
	before = _rss_gb()
	gc.collect()
	try:
		ctypes.CDLL('libc.so.6').malloc_trim(0)
	except (OSError, AttributeError):
		pass  # not glibc: nothing to trim
	return before, _rss_gb()
