from __future__ import annotations

import atexit
from pathlib import Path
import sys
from typing import IO

from .config import Config


class Tee:
	def __init__(self, *streams: IO[str]) -> None:
		self._streams = streams

	def write(self, data: str) -> int:
		for stream in self._streams:
			stream.write(data)
			stream.flush()
		return len(data)

	def flush(self) -> None:
		for stream in self._streams:
			stream.flush()


def setup_logging(folder: Path, cfg: Config) -> IO[str]:
	log_path = Path(cfg.log_file) if cfg.log_file else (folder / "freidata_publish.log")
	log_path.parent.mkdir(parents=True, exist_ok=True)
	log_file = log_path.open("a", encoding="utf-8")
	stdout = sys.stdout
	stderr = sys.stderr
	sys.stdout = Tee(stdout, log_file)
	sys.stderr = Tee(stderr, log_file)
	print(f"[LOG] Writing to {log_path}")

	def _cleanup() -> None:
		sys.stdout = stdout
		sys.stderr = stderr
		log_file.close()

	atexit.register(_cleanup)
	return log_file
