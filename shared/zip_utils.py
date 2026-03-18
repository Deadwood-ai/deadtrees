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
