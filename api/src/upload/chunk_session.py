"""Durable chunk receipts on the API server's local storage volume.

A client that declares its chunk size (`chunk_size` in the contract) may send
chunks in any order and several at a time: each chunk lands at index * chunk_size.
Without it, chunks must arrive in order and are appended, as before.

One lock covers receipt updates and finalization across threads and API workers.
Never delete a session/lock on completion: late requests must see its receipt,
and replacing a lock inode would let two workers enter the same session.
"""

from contextlib import contextmanager
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import time
from typing import BinaryIO, Callable, Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

# Receipt and lock directory under settings.base_path.
UPLOAD_SESSIONS_DIR = '.upload-sessions'

# Largest accepted chunk. The web app sends 50 MB and the CLI 100 MB chunks;
# nginx caps the request body a little above this (storage-server.conf).
MAX_CHUNK_BYTES = 128 * 1024 * 1024
# Most chunks one upload may have (as S3 multipart). Bounds the receipt, whose
# list has one entry per chunk index (500 GB in the web app's 50 MiB chunks).
MAX_CHUNKS = 10_000
# Chunks are hashed and copied in blocks of this size, never read whole.
COPY_BLOCK_BYTES = 1024 * 1024
# A request waits this long for another request of the same upload (a parallel
# chunk, or a finalization) before answering 503.
LOCK_WAIT_SECONDS = 120.0
LOCK_POLL_SECONDS = 0.05


class ChunkReceipt(BaseModel):
	size: int
	sha256: str


class UploadReceipt(BaseModel):
	user_id: str
	contract_hash: str
	# By chunk index; None marks a chunk that has not arrived yet (parallel uploads).
	chunks: list[ChunkReceipt | None] = Field(default_factory=list)
	phase: Literal['receiving', 'finalizing', 'complete'] = 'receiving'
	response: dict | None = None
	# The fields the client sends with every chunk, kept so a client can resume an
	# upload it no longer remembers. Receipts written before resume have none.
	contract: dict | None = None
	created_at: float | None = None


def _sync_directory(path: Path):
	directory = os.open(path, os.O_RDONLY)
	try:
		os.fsync(directory)
	finally:
		os.close(directory)


def measure_chunk(stream: BinaryIO) -> ChunkReceipt:
	"""Size and hash a chunk in blocks; reject it once it passes MAX_CHUNK_BYTES."""
	stream.seek(0)
	digest = hashlib.sha256()
	size = 0
	while block := stream.read(COPY_BLOCK_BYTES):
		size += len(block)
		if size > MAX_CHUNK_BYTES:
			raise HTTPException(
				status_code=413, detail=f'Upload chunk is larger than {MAX_CHUNK_BYTES // (1024 * 1024)} MiB'
			)
		digest.update(block)
	return ChunkReceipt(size=size, sha256=digest.hexdigest())


class ChunkSession:
	"""Own a locked upload's assembly, durable receipts, and final response."""

	def __init__(self, receipt_path: Path, target_path: Path, user_id: str, contract: dict):
		self.receipt_path = receipt_path
		self.target_path = target_path
		self.chunks_total = contract['chunks_total']
		self.chunk_size: int | None = contract.get('chunk_size')
		contract_hash = hashlib.sha256(json.dumps(contract, sort_keys=True).encode()).hexdigest()
		if receipt_path.exists():
			self.receipt = UploadReceipt.model_validate_json(receipt_path.read_bytes())
			if self.receipt.user_id != user_id:
				raise HTTPException(status_code=409, detail='Upload ID is already in use')
			if self.receipt.contract_hash != contract_hash:
				raise HTTPException(status_code=409, detail='Upload metadata or chunk count changed')
			if self.receipt.contract is None:
				self.receipt.contract = contract
		else:
			if target_path.exists():
				raise HTTPException(
					status_code=409, detail='Upload has no retry receipts; restart with a new upload ID'
				)
			self.receipt = UploadReceipt(
				user_id=user_id, contract_hash=contract_hash, contract=contract, created_at=time.time()
			)

	def _save(self):
		"""Replace the receipt atomically, after its referenced bytes are durable."""
		temporary = self.receipt_path.with_suffix('.pending')
		with temporary.open('w') as output:
			output.write(self.receipt.model_dump_json())
			output.flush()
			os.fsync(output.fileno())
		temporary.replace(self.receipt_path)
		_sync_directory(self.receipt_path.parent)

	def received(self) -> int:
		return sum(chunk is not None for chunk in self.receipt.chunks)

	def _offset(self, index: int, chunk: ChunkReceipt) -> int:
		"""Where a new chunk's bytes go, or a 409 when it may not be written now."""
		if self.chunk_size is None:
			if index != len(self.receipt.chunks):
				raise HTTPException(status_code=409, detail='Chunks must arrive in order')
			return sum(part.size for part in self.receipt.chunks)
		last = index == self.chunks_total - 1
		if chunk.size > self.chunk_size or (not last and chunk.size != self.chunk_size):
			raise HTTPException(status_code=409, detail='Chunk size does not match the declared chunk size')
		return index * self.chunk_size

	def accept(self, index: int, content: bytes | BinaryIO, measured: ChunkReceipt | None = None) -> dict | None:
		"""Return an existing reply, or None when all bytes are here and need finalization.

		`content` is the chunk's bytes or a seekable binary file. A file is hashed
		and copied in blocks, so a chunk never sits in memory as a whole. Pass
		`measured` (from measure_chunk) to hash before taking the session lock, so
		parallel chunks of one upload only take turns for the write.
		"""
		stream = io.BytesIO(content) if isinstance(content, (bytes, bytearray)) else content
		chunk = measured or measure_chunk(stream)
		if not chunk.size:
			raise HTTPException(status_code=422, detail='Empty upload chunk')
		chunks = self.receipt.chunks
		if index < len(chunks) and chunks[index] is not None:
			if chunks[index] != chunk:
				raise HTTPException(status_code=409, detail='Chunk content changed on retry')
		elif self.receipt.phase == 'receiving':
			offset = self._offset(index, chunk)
			# Persist the session before creating any data, including the first chunk.
			# A crashed write can then be repaired from the last committed receipt.
			if not self.receipt_path.exists():
				self._save()
			committed = sum(part.size for part in chunks if part is not None)
			if committed and (
				not self.target_path.exists() or (self.chunk_size is None and self.target_path.stat().st_size < offset)
			):
				raise HTTPException(status_code=409, detail='Upload data is missing; restart with a new upload ID')
			mode = 'r+b' if self.target_path.exists() else 'w+b'
			with self.target_path.open(mode) as output:
				if self.chunk_size is None:
					# Discard bytes of an interrupted, uncommitted append.
					output.truncate(offset)
				# A chunk at a fixed offset simply overwrites an uncommitted earlier attempt.
				output.seek(offset)
				stream.seek(0)
				while block := stream.read(COPY_BLOCK_BYTES):
					output.write(block)
				output.flush()
				os.fsync(output.fileno())
			_sync_directory(self.target_path.parent)
			chunks.extend([None] * (index + 1 - len(chunks)))
			chunks[index] = chunk
			self._save()

		if self.receipt.phase == 'finalizing':
			raise HTTPException(
				status_code=409,
				detail='Upload finalization was interrupted; contact support before starting another upload',
			)
		if self.receipt.phase == 'complete':
			return self.receipt.response
		if self.received() == self.chunks_total:
			return None
		return {'message': f'Chunk {index} of {self.chunks_total} received'}

	def begin_finalization(self, validate: Callable[[Path], None] | None = None):
		"""Fence the upload against repeated side effects, after validating its bytes.

		`validate` must be side-effect free. It runs on the assembled file before
		the fence, so a rejected upload keeps its receipt in `receiving` and every
		retry reports the same validation error.
		"""
		if self.received() != self.chunks_total or self.receipt.phase != 'receiving':
			raise HTTPException(status_code=409, detail='Upload is not ready for finalization')
		expected_size = sum(part.size for part in self.receipt.chunks if part is not None)
		if not self.target_path.exists() or self.target_path.stat().st_size < expected_size:
			raise HTTPException(status_code=409, detail='Upload data is missing; restart with a new upload ID')
		# Discard bytes beyond the committed chunks before processing.
		with self.target_path.open('r+b') as output:
			output.truncate(expected_size)
			output.flush()
			os.fsync(output.fileno())
		if validate is not None:
			validate(self.target_path)
		# The DB and filesystem are not one transaction. Persist a fence before
		# any DB insert so an ambiguous failure never repeats those side effects.
		self.receipt.phase = 'finalizing'
		self._save()

	def complete(self, response: dict):
		# The processors rename within this directory; make that rename durable
		# before promising a replayable successful response.
		_sync_directory(self.target_path.parent)
		self.receipt.response = response
		self.receipt.phase = 'complete'
		self._save()


@contextmanager
def locked_chunk_session(root: Path, upload_id: str, target_path: Path, user_id: str, contract: dict):
	root.mkdir(mode=0o700, parents=True, exist_ok=True)
	_sync_directory(root.parent)
	with (root / f'{upload_id}.lock').open('a+b') as lock:
		# Parallel chunks of one upload take turns for the short disk write; only a
		# long wait (such as a large finalization) ends in 503.
		deadline = time.monotonic() + LOCK_WAIT_SECONDS
		while True:
			try:
				fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
				break
			except BlockingIOError:
				if time.monotonic() >= deadline:
					raise HTTPException(
						status_code=503, detail='Upload request already in progress', headers={'Retry-After': '2'}
					)
				time.sleep(LOCK_POLL_SECONDS)
		try:
			yield ChunkSession(root / f'{upload_id}.json', target_path, user_id, contract)
		finally:
			fcntl.flock(lock, fcntl.LOCK_UN)
