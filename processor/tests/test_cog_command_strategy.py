import subprocess
from types import SimpleNamespace

from processor.src.cog import cog as cog_module


class _RasterStub:
	def __init__(self, count: int):
		self.count = count

	def __enter__(self):
		return self

	def __exit__(self, exc_type, exc, tb):
		return False


def _extract_band_indexes(command: list[str]) -> list[int]:
	band_indexes = []
	for index, value in enumerate(command[:-1]):
		if value == '-b':
			band_indexes.append(int(command[index + 1]))
	return band_indexes


def _has_creation_option(command: list[str], option: str) -> bool:
	for index, value in enumerate(command[:-1]):
		if value == '-co' and command[index + 1] == option:
			return True
	return False


def _patch_common(monkeypatch, band_count: int):
	monkeypatch.setattr(cog_module.rasterio, 'open', lambda *_args, **_kwargs: _RasterStub(band_count))
	monkeypatch.setattr(cog_module, 'cog_info', lambda cog_path: {'cog_path': cog_path})


def test_calculate_cog_uses_first_three_bands_for_four_band_inputs(monkeypatch):
	_patch_common(monkeypatch, band_count=4)
	commands: list[list[str]] = []

	def _run_success(command, check, capture_output, text):
		commands.append(command)
		return SimpleNamespace(stdout='ok', stderr='')

	monkeypatch.setattr(cog_module.subprocess, 'run', _run_success)

	result = cog_module.calculate_cog('input.tif', 'output.tif')

	assert result == {'cog_path': 'output.tif'}
	assert len(commands) == 1
	assert _extract_band_indexes(commands[0]) == [1, 2, 3]
	assert not _has_creation_option(commands[0], 'ALPHA=YES')
	assert _has_creation_option(commands[0], 'COMPRESS=JPEG')


def test_calculate_cog_uses_deflate_for_two_band_inputs(monkeypatch):
	_patch_common(monkeypatch, band_count=2)
	commands: list[list[str]] = []

	def _run_success(command, check, capture_output, text):
		commands.append(command)
		return SimpleNamespace(stdout='ok', stderr='')

	monkeypatch.setattr(cog_module.subprocess, 'run', _run_success)

	cog_module.calculate_cog('input.tif', 'output.tif')

	assert len(commands) == 1
	assert _extract_band_indexes(commands[0]) == [1, 2]
	assert _has_creation_option(commands[0], 'COMPRESS=DEFLATE')
	assert _has_creation_option(commands[0], 'OVERVIEW_COMPRESS=DEFLATE')
	assert not _has_creation_option(commands[0], 'ALPHA=YES')


def test_calculate_cog_logs_full_error_and_retries_with_epsg_3857(monkeypatch):
	_patch_common(monkeypatch, band_count=3)
	commands: list[list[str]] = []
	error_messages: list[str] = []

	def _run_with_retry(command, check, capture_output, text):
		commands.append(command)
		if len(commands) == 1:
			raise subprocess.CalledProcessError(
				returncode=1,
				cmd=command,
				output='partial stdout',
				stderr='boom stderr',
			)
		return SimpleNamespace(stdout='ok-after-retry', stderr='')

	monkeypatch.setattr(cog_module.subprocess, 'run', _run_with_retry)
	monkeypatch.setattr(cog_module.logger, 'error', lambda message, extra=None: error_messages.append(message))
	monkeypatch.setattr(cog_module.logger, 'info', lambda message, extra=None: None)

	cog_module.calculate_cog('input.tif', 'output.tif')

	assert len(commands) == 2
	assert '-a_srs' not in commands[0]
	assert '-a_srs' in commands[1]
	assert 'EPSG:3857' in commands[1]
	assert any('boom stderr' in message for message in error_messages)
	assert any('partial stdout' in message for message in error_messages)
