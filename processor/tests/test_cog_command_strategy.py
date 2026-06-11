import subprocess
from types import SimpleNamespace

import numpy as np
import pytest
import rasterio
import rasterio.enums
from rasterio.enums import Resampling
from rasterio.warp import reproject

from processor.src.cog import cog as cog_module
from processor.src.geotiff.standardise_geotiff import standardise_geotiff


pytestmark = pytest.mark.unit


class _RasterStub:
	def __init__(self, count: int, colorinterp=None):
		self.count = count
		self.colorinterp = colorinterp or [rasterio.enums.ColorInterp.undefined] * count

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


def _extract_mask_index(command: list[str]) -> int | None:
	for index, value in enumerate(command[:-1]):
		if value == '-mask':
			return int(command[index + 1])
	return None


def _has_creation_option(command: list[str], option: str) -> bool:
	for index, value in enumerate(command[:-1]):
		if value == '-co' and command[index + 1] == option:
			return True
	return False


def _patch_common(monkeypatch, band_count: int, colorinterp=None):
	monkeypatch.setattr(
		cog_module.rasterio,
		'open',
		lambda *_args, **_kwargs: _RasterStub(band_count, colorinterp=colorinterp),
	)
	monkeypatch.setattr(cog_module, 'cog_info', lambda cog_path: {'cog_path': cog_path})


def test_calculate_cog_uses_fourth_band_as_mask_for_rgba_inputs(monkeypatch):
	_patch_common(
		monkeypatch,
		band_count=4,
		colorinterp=[
			rasterio.enums.ColorInterp.red,
			rasterio.enums.ColorInterp.green,
			rasterio.enums.ColorInterp.blue,
			rasterio.enums.ColorInterp.alpha,
		],
	)
	commands: list[list[str]] = []

	def _run_success(command, check, capture_output, text):
		commands.append(command)
		return SimpleNamespace(stdout='ok', stderr='')

	monkeypatch.setattr(cog_module.subprocess, 'run', _run_success)

	result = cog_module.calculate_cog('input.tif', 'output.tif')

	assert result == {'cog_path': 'output.tif'}
	assert len(commands) == 1
	assert _extract_band_indexes(commands[0]) == [1, 2, 3]
	assert _extract_mask_index(commands[0]) == 4
	assert not _has_creation_option(commands[0], 'ALPHA=YES')
	assert _has_creation_option(commands[0], 'COMPRESS=JPEG')


def test_calculate_cog_uses_first_three_bands_for_four_band_non_alpha_inputs(monkeypatch):
	_patch_common(monkeypatch, band_count=4)
	commands: list[list[str]] = []

	def _run_success(command, check, capture_output, text):
		commands.append(command)
		return SimpleNamespace(stdout='ok', stderr='')

	monkeypatch.setattr(cog_module.subprocess, 'run', _run_success)

	cog_module.calculate_cog('input.tif', 'output.tif')

	assert len(commands) == 1
	assert _extract_band_indexes(commands[0]) == [1, 2, 3]
	assert _extract_mask_index(commands[0]) is None
	assert not _has_creation_option(commands[0], 'ALPHA=YES')
	assert _has_creation_option(commands[0], 'COMPRESS=JPEG')


def test_calculate_cog_uses_trailing_alpha_as_mask_for_three_band_inputs(monkeypatch):
	_patch_common(
		monkeypatch,
		band_count=3,
		colorinterp=[
			rasterio.enums.ColorInterp.gray,
			rasterio.enums.ColorInterp.undefined,
			rasterio.enums.ColorInterp.alpha,
		],
	)
	commands: list[list[str]] = []

	def _run_success(command, check, capture_output, text):
		commands.append(command)
		return SimpleNamespace(stdout='ok', stderr='')

	monkeypatch.setattr(cog_module.subprocess, 'run', _run_success)

	cog_module.calculate_cog('input.tif', 'output.tif')

	assert len(commands) == 1
	assert _extract_band_indexes(commands[0]) == [1, 2, 1]
	assert _extract_mask_index(commands[0]) == 3
	assert _has_creation_option(commands[0], 'COMPRESS=JPEG')
	assert _has_creation_option(commands[0], 'OVERVIEW_COMPRESS=JPEG')
	assert not _has_creation_option(commands[0], 'ALPHA=YES')


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


def test_calculate_cog_preserves_rgba_alpha_as_internal_mask(tmp_path):
	input_path = tmp_path / 'rgba_input.tif'
	output_path = tmp_path / 'rgba_cog.tif'
	width = 64
	height = 64
	y, x = np.mgrid[0:height, 0:width]
	data = np.zeros((4, height, width), dtype=np.uint8)
	data[0] = 40 + x
	data[1] = 60 + y
	data[2] = 80 + ((x + y) // 2)
	alpha_mask = np.zeros((height, width), dtype=bool)
	alpha_mask[:16, :] = True
	alpha_mask[32:46, 28:44] = True
	data[3] = np.where(alpha_mask, 0, 255).astype(np.uint8)

	profile = {
		'driver': 'GTiff',
		'dtype': 'uint8',
		'width': width,
		'height': height,
		'count': 4,
		'crs': 'EPSG:32608',
		'transform': rasterio.transform.from_origin(442000.0, 7390000.0, 0.5, 0.5),
	}
	with rasterio.open(input_path, 'w', **profile) as dst:
		dst.write(data)
		dst.colorinterp = (
			rasterio.enums.ColorInterp.red,
			rasterio.enums.ColorInterp.green,
			rasterio.enums.ColorInterp.blue,
			rasterio.enums.ColorInterp.alpha,
		)

	cog_module.calculate_cog(str(input_path), str(output_path))

	with rasterio.open(input_path) as source, rasterio.open(output_path) as cog:
		alpha_transparent = (source.read(4) == 0).astype(np.uint8)
		footprint = np.ones((source.height, source.width), dtype=np.uint8)
		alpha_on_cog = np.zeros((cog.height, cog.width), dtype=np.uint8)
		footprint_on_cog = np.zeros((cog.height, cog.width), dtype=np.uint8)
		reproject(
			alpha_transparent,
			alpha_on_cog,
			src_transform=source.transform,
			src_crs=source.crs,
			dst_transform=cog.transform,
			dst_crs=cog.crs,
			resampling=Resampling.nearest,
		)
		reproject(
			footprint,
			footprint_on_cog,
			src_transform=source.transform,
			src_crs=source.crs,
			dst_transform=cog.transform,
			dst_crs=cog.crs,
			resampling=Resampling.nearest,
		)
		expected_transparent = (alpha_on_cog == 1) | (footprint_on_cog == 0)
		actual_transparent = cog.dataset_mask() == 0

		assert cog.count == 3
		assert list(cog.colorinterp) == [
			rasterio.enums.ColorInterp.red,
			rasterio.enums.ColorInterp.green,
			rasterio.enums.ColorInterp.blue,
		]
		assert np.array_equal(actual_transparent, expected_transparent)


def test_two_band_high_nodata_standardise_then_cog_preserves_internal_mask(tmp_path):
	input_path = tmp_path / 'two_band_uint16_input.tif'
	standardized_path = tmp_path / 'two_band_standardized.tif'
	cog_path = tmp_path / 'two_band_cog.tif'
	width = 64
	height = 64
	y, x = np.mgrid[0:height, 0:width]
	data = np.zeros((2, height, width), dtype=np.uint16)
	data[0] = 1000 + x * 10
	data[1] = 2000 + y * 8
	nodata_mask = np.zeros((height, width), dtype=bool)
	nodata_mask[:12, :] = True
	nodata_mask[30:44, 28:46] = True
	data[:, nodata_mask] = 65535

	profile = {
		'driver': 'GTiff',
		'dtype': 'uint16',
		'width': width,
		'height': height,
		'count': 2,
		'crs': 'EPSG:32608',
		'transform': rasterio.transform.from_origin(442000.0, 7390000.0, 0.5, 0.5),
	}
	with rasterio.open(input_path, 'w', **profile) as dst:
		dst.write(data)
		dst.colorinterp = (rasterio.enums.ColorInterp.gray, rasterio.enums.ColorInterp.undefined)

	assert standardise_geotiff(str(input_path), str(standardized_path), token='test-token', dataset_id=10388)
	cog_module.calculate_cog(str(standardized_path), str(cog_path))

	with rasterio.open(standardized_path) as source, rasterio.open(cog_path) as cog:
		assert source.count == 4
		assert source.colorinterp[3] == rasterio.enums.ColorInterp.alpha
		assert cog.count == 3

		alpha_transparent = (source.read(4) == 0).astype(np.uint8)
		footprint = np.ones((source.height, source.width), dtype=np.uint8)
		alpha_on_cog = np.zeros((cog.height, cog.width), dtype=np.uint8)
		footprint_on_cog = np.zeros((cog.height, cog.width), dtype=np.uint8)
		reproject(
			alpha_transparent,
			alpha_on_cog,
			src_transform=source.transform,
			src_crs=source.crs,
			dst_transform=cog.transform,
			dst_crs=cog.crs,
			resampling=Resampling.nearest,
		)
		reproject(
			footprint,
			footprint_on_cog,
			src_transform=source.transform,
			src_crs=source.crs,
			dst_transform=cog.transform,
			dst_crs=cog.crs,
			resampling=Resampling.nearest,
		)
		expected_transparent = (alpha_on_cog == 1) | (footprint_on_cog == 0)
		actual_transparent = cog.dataset_mask() == 0

		assert np.array_equal(actual_transparent, expected_transparent)


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
