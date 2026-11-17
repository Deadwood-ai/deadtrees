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
	last_chunk: ChunkReceipt | None
	# Size and SHA-256 of every received chunk, in order. Before it resumes, a
	# client compares them with its file, so a resume never appends one file's
	# bytes to another's. Left out of the list call.
	chunks: list[ChunkReceipt] | None = None
	# The fields every chunk must repeat; None for receipts written before resume.
	contract: dict | None
	# The dataset response, once the upload is complete.
	response: dict | None
	created_at: float | None
	updated_at: float


def _state(receipt: UploadReceipt, committed: int, tmp_paths: list[Path]) -> UploadState:
	if receipt.phase != 'receiving':
		return receipt.phase
	if committed and not any(path.exists() and path.stat().st_size >= committed for path in tmp_paths):
		return 'expired'
	return 'receiving'


def read_upload_status(
	session_root: Path, upload_id: str, user_id: str, upload_dirs: list[Path], with_chunks: bool = True
) -> UploadStatus | None:
	"""Return the caller's upload, or None when it does not exist or belongs to someone else."""
	receipt_path = session_root / f'{upload_id}.json'
	try:
		updated_at = receipt_path.stat().st_mtime
		receipt = UploadReceipt.model_validate_json(receipt_path.read_bytes())
	except (FileNotFoundError, ValidationError):
		return None
	if receipt.user_id != user_id:
		return None
	committed = sum(chunk.size for chunk in receipt.chunks)
	return UploadStatus(
		upload_id=upload_id,
		state=_state(receipt, committed, [d / f'{upload_id}.tmp' for d in upload_dirs]),
		chunks_total=(receipt.contract or {}).get('chunks_total'),
		chunks_received=len(receipt.chunks),
		bytes_received=committed,
		last_chunk=receipt.chunks[-1] if receipt.chunks else None,
		chunks=receipt.chunks if with_chunks else None,
		contract=receipt.contract,
		response=receipt.response if receipt.phase == 'complete' else None,
		created_at=receipt.created_at,
		updated_at=updated_at,
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
			status = read_upload_status(
				session_root, entry.name.removesuffix('.json'), user_id, upload_dirs, with_chunks=False
			)
			if status is not None and status.state in ('receiving', 'finalizing'):
				found.append(status)
	return sorted(found, key=lambda status: status.updated_at, reverse=True)
