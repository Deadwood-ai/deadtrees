import shutil
import zipfile
from collections import Counter
from pathlib import Path
from typing import Dict, Iterable, Optional, Set


# We keep support intentionally conservative so behavior is consistent
# across environments and Python runtimes.
DEFAULT_ALLOWED_ZIP_METHODS: Set[int] = {
	zipfile.ZIP_STORED,
	zipfile.ZIP_DEFLATED,
}


class UnsupportedZipCompressionError(ValueError):
	def __init__(self, unsupported_methods: Dict[int, int], allowed_methods: Iterable[int]):
		self.unsupported_methods = unsupported_methods
		self.allowed_methods = set(allowed_methods)
		message = _build_unsupported_methods_message(unsupported_methods, self.allowed_methods)
		super().__init__(message)


class InvalidZipArchiveError(ValueError):
	pass


class ZipExtractionLimitError(ValueError):
	"""The archive would unpack beyond a file count, size, ratio or disk budget."""


# Limits for unpacking an uploaded raw-image ZIP. Drone photos barely compress,
# so a high ratio means a crafted archive, not a real flight.
MAX_ZIP_MEMBERS = 100_000
MAX_ZIP_UNPACKED_BYTES = 1024**4  # 1 TiB
MAX_ZIP_MEMBER_RATIO = 100
# Only members that unpack to more than this are ratio-checked; tiny text files
# (for example RTK logs) can legitimately compress very well.
ZIP_RATIO_CHECK_MIN_BYTES = 16 * 1024 * 1024
# Free space to leave on the target disk after unpacking.
ZIP_DISK_RESERVE_BYTES = 20 * 1024**3


def check_zip_extraction_budget(
	zip_path: Path,
	target_dir: Path,
	*,
	max_members: int = MAX_ZIP_MEMBERS,
	max_unpacked_bytes: int = MAX_ZIP_UNPACKED_BYTES,
	max_member_ratio: int = MAX_ZIP_MEMBER_RATIO,
	disk_reserve_bytes: int = ZIP_DISK_RESERVE_BYTES,
) -> int:
	"""Check an archive's declared sizes before unpacking; return its unpacked size.

	zipfile never writes more than a member's declared size (and checks its
	CRC), so a budget on the declared sizes bounds what extraction writes.

	Raises:
		InvalidZipArchiveError: if the archive is not a valid ZIP.
		ZipExtractionLimitError: if a limit or the free disk space would be exceeded.
	"""
	try:
		with zipfile.ZipFile(zip_path, 'r') as archive:
			members = archive.infolist()
	except zipfile.BadZipFile as exc:
		raise InvalidZipArchiveError(f'Invalid ZIP archive: {zip_path.name}') from exc

	if len(members) > max_members:
		raise ZipExtractionLimitError(f'ZIP has {len(members)} entries; the limit is {max_members}')
	total = 0
	for member in members:
		if member.file_size >= ZIP_RATIO_CHECK_MIN_BYTES and (
			member.compress_size == 0 or member.file_size / member.compress_size > max_member_ratio
		):
			raise ZipExtractionLimitError(
				f'ZIP entry {member.filename!r} unpacks {member.file_size} bytes from '
				f'{member.compress_size}; the ratio limit is {max_member_ratio}'
			)
		total += member.file_size
	if total > max_unpacked_bytes:
		raise ZipExtractionLimitError(f'ZIP unpacks to {total} bytes; the limit is {max_unpacked_bytes}')
	free = shutil.disk_usage(target_dir).free
	if total > free - disk_reserve_bytes:
		raise ZipExtractionLimitError(
			f'ZIP unpacks to {total} bytes, but only {free} bytes are free on the processing disk '
			f'and {disk_reserve_bytes} must stay free'
		)
	return total


def inspect_zip_compression_methods(zip_path: Path) -> Dict[int, int]:
	"""Return a count of compression methods used in a ZIP archive."""
	try:
		with zipfile.ZipFile(zip_path, 'r') as archive:
			method_counts = Counter(info.compress_type for info in archive.infolist())
	except zipfile.BadZipFile as exc:
		raise InvalidZipArchiveError(f'Invalid ZIP archive: {zip_path.name}') from exc

	return dict(method_counts)


def ensure_supported_zip_compression(
	zip_path: Path, allowed_methods: Optional[Iterable[int]] = None
) -> Dict[int, int]:
	"""
	Validate ZIP compression methods and return method counts.

	Raises:
		InvalidZipArchiveError: if archive is not a valid ZIP.
		UnsupportedZipCompressionError: if unsupported compression methods are found.
	"""
	allowed = set(allowed_methods or DEFAULT_ALLOWED_ZIP_METHODS)
	method_counts = inspect_zip_compression_methods(zip_path)
	unsupported = {method: count for method, count in method_counts.items() if method not in allowed}

	if unsupported:
		raise UnsupportedZipCompressionError(unsupported_methods=unsupported, allowed_methods=allowed)

	return method_counts


def _build_unsupported_methods_message(unsupported: Dict[int, int], allowed: Set[int]) -> str:
	unsupported_parts = [
		f'{_zip_method_name(method)} (method {method}, {count} file(s))'
		for method, count in sorted(unsupported.items())
	]
	allowed_parts = [f'{_zip_method_name(method)} (method {method})' for method in sorted(allowed)]
	unsupported_text = ', '.join(unsupported_parts)
	allowed_text = ', '.join(allowed_parts)
	return (
		f'Unsupported ZIP compression method(s): {unsupported_text}. '
		f'Please re-compress the ZIP using one of: {allowed_text}.'
	)


def _zip_method_name(method: int) -> str:
	return zipfile.compressor_names.get(method, f'unknown-{method}')
