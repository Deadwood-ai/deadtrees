import hashlib
from pathlib import Path


def get_file_identifier(file_path: Path, sample_size: int = 10 * 1024 * 1024) -> str:
	"""Generate a quick file identifier by sampling start/end of file

	SHA-256 over the decimal file size, the first `sample_size` bytes and the last
	`sample_size` bytes (the whole file twice when it is smaller). Duplicate-upload
	detection compares this value across clients, so the upload dialog computes
	the same bytes in frontend/src/utils/uploadFingerprint.ts: change both together.
	"""
	file_size = file_path.stat().st_size
	hasher = hashlib.sha256()

	with open(file_path, 'rb') as f:
		# Hash file size
		hasher.update(str(file_size).encode())

		# Hash first 10MB
		hasher.update(f.read(sample_size))

		# Hash last 10MB
		f.seek(-min(sample_size, file_size), 2)
		hasher.update(f.read(sample_size))

	return hasher.hexdigest()
