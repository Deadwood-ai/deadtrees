import zipfile
from pathlib import Path

import pytest

from shared.zip_utils import (
	ensure_supported_zip_compression,
	inspect_zip_compression_methods,
	UnsupportedZipCompressionError,
	InvalidZipArchiveError,
)


def _create_deflated_zip(zip_path: Path) -> None:
	with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
		archive.writestr('image_1.jpg', b'test-image-data-1')
		archive.writestr('image_2.jpg', b'test-image-data-2')


def test_inspect_zip_compression_methods_returns_counts(tmp_path: Path):
	zip_path = tmp_path / 'valid.zip'
	_create_deflated_zip(zip_path)

	method_counts = inspect_zip_compression_methods(zip_path)
	assert method_counts[zipfile.ZIP_DEFLATED] == 2


def test_ensure_supported_zip_compression_accepts_deflate(tmp_path: Path):
	zip_path = tmp_path / 'valid.zip'
	_create_deflated_zip(zip_path)

	method_counts = ensure_supported_zip_compression(zip_path)
	assert method_counts[zipfile.ZIP_DEFLATED] == 2


def test_ensure_supported_zip_compression_rejects_disallowed_methods(tmp_path: Path):
	zip_path = tmp_path / 'valid.zip'
	_create_deflated_zip(zip_path)

	with pytest.raises(UnsupportedZipCompressionError) as exc_info:
		ensure_supported_zip_compression(zip_path, allowed_methods={zipfile.ZIP_STORED})

	assert 'Unsupported ZIP compression method(s)' in str(exc_info.value)
	assert 'deflate' in str(exc_info.value).lower()


def test_inspect_zip_compression_methods_rejects_invalid_archive(tmp_path: Path):
	zip_path = tmp_path / 'invalid.zip'
	zip_path.write_text('not-a-zip-file', encoding='utf-8')

	with pytest.raises(InvalidZipArchiveError) as exc_info:
		inspect_zip_compression_methods(zip_path)

	assert 'Invalid ZIP archive' in str(exc_info.value)
