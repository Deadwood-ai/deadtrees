"""Delete the bytes of chunked uploads that were abandoned before finalization.

An upload that never sends its last chunk (or whose final chunk was rejected by
validation) leaves `<upload_id>.tmp` in the archive or raw-images directory.
This job deletes such a file once neither it nor its receipt changed for
`max_age`. Receipts and lock files stay (see
docs/playbooks/upload-retry-contract.md): a later retry of that ID gets HTTP 409
"Upload data is missing; restart with a new upload ID".

Only uploads that are still `receiving`, or have no receipt at all, are
eligible. A `finalizing` receipt marks an interrupted finalization that needs
manual inspection, so its bytes are kept.

Run inside the API container, for example from
scripts/cron_cleanup_abandoned_uploads_docker.sh:

	python /app/api/src/upload/abandoned_uploads.py --max-age-days 7 [--dry-run]
"""

import argparse
from datetime import timedelta
import fcntl
import os
from pathlib import Path
import re
import sys
import time

from pydantic import ValidationError

from shared.settings import settings
from api.src.upload.chunk_session import UPLOAD_SESSIONS_DIR, UploadReceipt

DEFAULT_MAX_AGE_DAYS = 7
UPLOAD_ID_PATTERN = re.compile(r'^[A-Za-z0-9_-]{1,128}$')


def _last_activity(paths: list[Path]) -> float:
	return max(path.stat().st_mtime for path in paths if path.exists())


def _is_abandoned(receipt_path: Path, tmp_path: Path, cutoff: float) -> bool:
	if receipt_path.exists():
		try:
			phase = UploadReceipt.model_validate_json(receipt_path.read_bytes()).phase
		except ValidationError:
			print(f'Keeping {tmp_path}: unreadable receipt {receipt_path}')
			return False
		if phase != 'receiving':
			return False
	return _last_activity([tmp_path, receipt_path]) < cutoff


def cleanup_abandoned_uploads(
	session_root: Path,
	upload_dirs: list[Path],
	max_age: timedelta,
	now: float | None = None,
	dry_run: bool = False,
) -> list[Path]:
	"""Delete abandoned `<upload_id>.tmp` files and return the paths removed."""
	cutoff = (time.time() if now is None else now) - max_age.total_seconds()
	removed: list[Path] = []
	for directory in upload_dirs:
		if not directory.is_dir():
			continue
		for tmp_path in sorted(directory.glob('*.tmp')):
			upload_id = tmp_path.stem
			if not UPLOAD_ID_PATTERN.match(upload_id) or not tmp_path.is_file():
				continue
			receipt_path = session_root / f'{upload_id}.json'
			lock_path = session_root / f'{upload_id}.lock'
			# Hold the upload route's lock so no request writes while we decide and delete.
			lock = lock_path.open('rb') if lock_path.exists() else None
			try:
				if lock is not None:
					try:
						fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
					except BlockingIOError:
						continue
				if not _is_abandoned(receipt_path, tmp_path, cutoff):
					continue
				if not dry_run:
					tmp_path.unlink()
				removed.append(tmp_path)
			finally:
				if lock is not None:
					lock.close()
	return removed


def main(argv: list[str] | None = None) -> int:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument(
		'--max-age-days',
		type=float,
		default=float(os.getenv('UPLOAD_TMP_RETENTION_DAYS', DEFAULT_MAX_AGE_DAYS)),
		help=f'Idle days before abandoned bytes are deleted (default {DEFAULT_MAX_AGE_DAYS}, env UPLOAD_TMP_RETENTION_DAYS)',
	)
	parser.add_argument('--dry-run', action='store_true', help='List the files without deleting them')
	args = parser.parse_args(argv)
	if args.max_age_days <= 0:
		parser.error('--max-age-days must be positive')

	removed = cleanup_abandoned_uploads(
		settings.base_path / UPLOAD_SESSIONS_DIR,
		[settings.archive_path, settings.raw_images_path],
		timedelta(days=args.max_age_days),
		dry_run=args.dry_run,
	)
	verb = 'Would delete' if args.dry_run else 'Deleted'
	for path in removed:
		print(f'{verb} abandoned upload {path}')
	print(f'{verb} {len(removed)} abandoned upload file(s) idle for more than {args.max_age_days:g} day(s)')
	return 0


if __name__ == '__main__':
	sys.exit(main())
