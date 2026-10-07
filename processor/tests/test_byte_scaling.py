"""Byte scaling for high bit-depth orthos (DT-1361).

Regression source: dataset 14750, a linear-reflectance uint16 MATLAB export
whose centre is a snowy clearcut. Sampling only the centre and stretching
linearly rendered the surrounding spruce forest almost black.
"""

import numpy as np
import pytest
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin

from processor.src.geotiff.byte_scaling import (
	MIN_EXPONENT,
	ByteScaling,
	compute_byte_scaling,
)
from processor.src.geotiff.standardise_geotiff import standardise_geotiff

SIZE = 400


def _profile(count=3, dtype='uint16'):
	return {
		'driver': 'GTiff',
		'dtype': dtype,
		'width': SIZE,
		'height': SIZE,
		'count': count,
		'crs': 'EPSG:32633',
		'transform': from_origin(419503.0, 6483499.0, 0.06, 0.06),
	}


def _linear_forest_with_snowy_centre():
	"""Dark linear canopy around a snowy clearcut that fills the centre quarter."""
	rng = np.random.default_rng(14750)
	data = rng.integers(200, 1500, size=(3, SIZE, SIZE)).astype('uint16')
	data[:, 100:300, 100:300] = rng.integers(12000, 16000, size=(3, 200, 200))
	return data


def _scaling(data, **kwargs):
	with MemoryFile() as memfile:
		with memfile.open(**_profile(count=data.shape[0], dtype=str(data.dtype))) as dst:
			dst.write(data)
		with memfile.open() as src:
			return compute_byte_scaling(src, min(data.shape[0], 3), **kwargs)


@pytest.mark.unit
def test_linear_dark_image_gets_display_gamma():
	scaling = _scaling(_linear_forest_with_snowy_centre())

	assert scaling.median_brightness < 0.15
	assert scaling.exponent == pytest.approx(MIN_EXPONENT, abs=0.1)
	assert '-exponent_1' in scaling.translate_args()


@pytest.mark.unit
def test_scaling_samples_the_whole_image_not_only_the_centre():
	scaling = _scaling(_linear_forest_with_snowy_centre())

	# A centre-only sample sees nothing but snow and clips the forest to black.
	for low, high in scaling.band_ranges:
		assert low < 300
		assert high > 12000


@pytest.mark.unit
def test_mid_tone_image_keeps_linear_stretch():
	y, x = np.mgrid[0:SIZE, 0:SIZE]
	data = np.stack([8000 + x * 60, 9000 + y * 60, 7000 + (x + y) * 30]).astype('uint16')

	scaling = _scaling(data)

	assert scaling.exponent == 1.0
	assert not any(arg.startswith('-exponent') for arg in scaling.translate_args())


@pytest.mark.unit
def test_undetected_black_collar_does_not_trigger_gamma():
	y, x = np.mgrid[0:SIZE, 0:SIZE]
	data = np.stack([8000 + x * 60, 9000 + y * 60, 7000 + (x + y) * 30]).astype('uint16')
	data[:, :, :260] = 0  # fill collar that nodata detection did not catch

	scaling = _scaling(data)

	assert scaling.exponent == 1.0


@pytest.mark.unit
def test_excluded_nodata_and_transparent_alpha_are_ignored():
	data = np.full((4, SIZE, SIZE), 9000, dtype='uint16')
	data[:3, :, : SIZE // 2] = 65535  # sentinel nodata half
	data[3] = 65535
	data[3, : SIZE // 4, :] = 0  # transparent strip with dark values underneath
	data[:3, : SIZE // 4, :] = 1

	scaling = _scaling(data, alpha_band_index=4, excluded_values=(65535.0,))

	assert scaling.band_ranges == ((9000.0, 9000.0),) * 3
	assert scaling.constant_bands == [1, 2, 3]


@pytest.mark.unit
def test_translate_args_use_fallback_range_for_constant_bands():
	scaling = ByteScaling(band_ranges=((10.0, 20.0), (5.0, 5.0)), exponent=0.5)

	assert scaling.translate_args() == [
		'-scale_1', '10.0', '20.0', '0', '255', '-exponent_1', '0.5000',
		'-scale_2', '0.0', '65535.0', '0', '255', '-exponent_2', '0.5000',
	]  # fmt: skip


@pytest.mark.unit
def test_standardised_linear_ortho_is_not_black(tmp_path):
	input_path = tmp_path / 'linear_reflectance.tif'
	output_path = tmp_path / 'standardised.tif'
	with rasterio.open(input_path, 'w', **_profile()) as dst:
		dst.write(_linear_forest_with_snowy_centre())

	assert standardise_geotiff(str(input_path), str(output_path), token='test-token', dataset_id=14750)

	with rasterio.open(output_path) as dst:
		rgb = dst.read([1, 2, 3]).astype(float)
	forest = np.ones((SIZE, SIZE), dtype=bool)
	forest[100:300, 100:300] = False
	brightness = rgb.mean(axis=0)[forest]
	assert np.median(brightness) > 45
	assert np.mean(brightness < 30) < 0.25
