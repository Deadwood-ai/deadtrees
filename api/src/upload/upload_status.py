"""Read-only view of chunked uploads, so a client can resume one (DT-1567).

Reads the receipts that chunk_session.py writes. Receipts are replaced
atomically, so a read without the session lock sees either the old or the new
receipt, never a mix. Only the receipt's owner sees an upload.
"""

import os
from pathlib import Path
import time
from typing import Literal

from pydantic import BaseModel, ValidationError

from .chunk_session import ChunkReceipt, UploadReceipt

# `expired`: the retention job deleted the received bytes; the client must start again.
# `finalizing`: the last chunk was accepted but finalization never confirmed; needs support.
UploadState = Literal['receiving', 'expired', 'finalizing', 'complete']


class UploadStatus(BaseModel):
	upload_id: str
	state: UploadState
	chunks_total: int | None
	chunks_received: int
	bytes_received: int
	# The client compares this with the same slice of its file before it sends
	# the next chunk, so a resume never appends a different file.
	last_chunk: ChunkReceipt | None
	# The fields every chunk must repeat; None for receipts written before resume.
	contract: dict | None
	# The dataset response, once the upload is complete.
	response: dict | None
	created_at: float | None
	updated_at: float


def _state(receipt: UploadReceipt, tmp_paths: list[Path]) -> UploadState:
	if receipt.phase != 'receiving':
		return receipt.phase
	committed = sum(chunk.size for chunk in receipt.chunks)
	if committed and not any(path.exists() and path.stat().st_size >= committed for path in tmp_paths):
		return 'expired'
	return 'receiving'


def _read(receipt_path: Path, upload_id: str, user_id: str, tmp_paths: list[Path]) -> UploadStatus | None:
	try:
		updated_at = receipt_path.stat().st_mtime
		receipt = UploadReceipt.model_validate_json(receipt_path.read_bytes())
	except (FileNotFoundError, ValidationError):
		return None
	if receipt.user_id != user_id:
		return None
	return UploadStatus(
		upload_id=upload_id,
		state=_state(receipt, tmp_paths),
		chunks_total=(receipt.contract or {}).get('chunks_total'),
		chunks_received=len(receipt.chunks),
		bytes_received=sum(chunk.size for chunk in receipt.chunks),
		last_chunk=receipt.chunks[-1] if receipt.chunks else None,
		contract=receipt.contract,
		response=receipt.response if receipt.phase == 'complete' else None,
		created_at=receipt.created_at,
		updated_at=updated_at,
	)


def read_upload_status(session_root: Path, upload_id: str, user_id: str, upload_dirs: list[Path]) -> UploadStatus | None:
	"""Return the caller's upload, or None when it does not exist or belongs to someone else."""
	return _read(
		session_root / f'{upload_id}.json', upload_id, user_id, [d / f'{upload_id}.tmp' for d in upload_dirs]
	)


def list_unfinished_uploads(
	session_root: Path, user_id: str, upload_dirs: list[Path], max_age_seconds: float, now: float | None = None
) -> list[UploadStatus]:
	"""The caller's uploads that can still be resumed or need support, newest first.

	Only receipts changed within `max_age_seconds` are read; older bytes are
	deleted by the retention job (abandoned_uploads.py) anyway.
	"""
	if not session_root.is_dir():
		return []
	cutoff = (time.time() if now is None else now) - max_age_seconds
	found: list[UploadStatus] = []
	with os.scandir(session_root) as entries:
		for entry in entries:
			if not entry.name.endswith('.json'):
				continue
			try:
				if entry.stat().st_mtime < cutoff:
					continue
			except FileNotFoundError:
				continue
			upload_id = entry.name.removesuffix('.json')
			status = _read(Path(entry.path), upload_id, user_id, [d / f'{upload_id}.tmp' for d in upload_dirs])
			if status is not None and status.state in ('receiving', 'finalizing'):
				found.append(status)
	return sorted(found, key=lambda status: status.updated_at, reverse=True)
