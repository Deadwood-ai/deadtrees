import zipfile
from collections import namedtuple
from pathlib import Path

import pytest

from shared import zip_utils
from shared.zip_utils import (
	check_zip_extraction_budget,
	ZipExtractionLimitError,
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


shutil_usage = namedtuple('usage', 'total used free', defaults=(0, 0, 0))


def _zip_with(zip_path: Path, members: dict, compression=zipfile.ZIP_DEFLATED) -> None:
	with zipfile.ZipFile(zip_path, 'w', compression=compression) as archive:
		for name, data in members.items():
			archive.writestr(name, data)


def test_extraction_budget_returns_unpacked_size(tmp_path: Path):
	zip_path = tmp_path / 'ok.zip'
	_zip_with(zip_path, {'a.jpg': b'x' * 10, 'b.jpg': b'y' * 20})
	assert check_zip_extraction_budget(zip_path, tmp_path, disk_reserve_bytes=0) == 30


def test_extraction_budget_rejects_too_many_members(tmp_path: Path):
	zip_path = tmp_path / 'many.zip'
	_zip_with(zip_path, {f'{i}.jpg': b'x' for i in range(3)})
	with pytest.raises(ZipExtractionLimitError, match='entries'):
		check_zip_extraction_budget(zip_path, tmp_path, max_members=2, disk_reserve_bytes=0)


def test_extraction_budget_rejects_large_total(tmp_path: Path):
	zip_path = tmp_path / 'big.zip'
	_zip_with(zip_path, {'a.jpg': b'x' * 100}, compression=zipfile.ZIP_STORED)
	with pytest.raises(ZipExtractionLimitError, match='unpacks to 100 bytes'):
		check_zip_extraction_budget(zip_path, tmp_path, max_unpacked_bytes=99, disk_reserve_bytes=0)


def test_extraction_budget_rejects_zip_bomb_ratio(tmp_path: Path):
	zip_path = tmp_path / 'bomb.zip'
	# 17 MiB of zeros deflates to a few KiB: far above the ratio limit.
	_zip_with(zip_path, {'zeros.tif': b'\0' * (17 * 1024 * 1024)})
	with pytest.raises(ZipExtractionLimitError, match='ratio limit'):
		check_zip_extraction_budget(zip_path, tmp_path, disk_reserve_bytes=0)


def test_extraction_budget_keeps_disk_reserve(tmp_path: Path, monkeypatch):
	zip_path = tmp_path / 'ok.zip'
	_zip_with(zip_path, {'a.jpg': b'x' * 10})
	monkeypatch.setattr(zip_utils.shutil, 'disk_usage', lambda _path: shutil_usage(free=15))
	with pytest.raises(ZipExtractionLimitError, match='free on the processing disk'):
		check_zip_extraction_budget(zip_path, tmp_path, disk_reserve_bytes=10)


def test_extraction_budget_rejects_invalid_zip(tmp_path: Path):
	zip_path = tmp_path / 'broken.zip'
	zip_path.write_bytes(b'not a zip')
	with pytest.raises(InvalidZipArchiveError):
		check_zip_extraction_budget(zip_path, tmp_path)
