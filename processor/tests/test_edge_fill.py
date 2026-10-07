"""Edge fill collars without nodata metadata become transparent (DT-1362).

Regression source: 1,034 live 8-bit orthos (for example 2344–2366 with white
and 12105 with black collars) were tiled and compressed, took the
already-standardised copy path and kept their collar visible on the map.
"""

import numpy as np
import pytest
import rasterio
from rasterio.enums import ColorInterp
from rasterio.transform import from_origin

from processor.src.geotiff.edge_fill import has_edge_fill
from processor.src.geotiff.standardise_geotiff import standardise_geotiff

SIZE = 256


def _footprint(margin=0):
	"""A rotated-looking diamond footprint inside a rectangular raster.

	nearblack also clears the couple of edge pixels it scans past before it
	stops, so content checks use the footprint shrunk by ``margin`` pixels.
	"""
	y, x = np.mgrid[0:SIZE, 0:SIZE]
	return (np.abs(x - SIZE / 2) + np.abs(y - SIZE / 2)) < SIZE * 0.4 - margin


def _write(path, data, alpha=None, compress='DEFLATE'):
	count = data.shape[0] + (1 if alpha is not None else 0)
	with rasterio.open(
		path,
		'w',
		driver='GTiff',
		width=SIZE,
		height=SIZE,
		count=count,
		dtype='uint8',
		crs='EPSG:32633',
		transform=from_origin(400000.0, 6400000.0, 0.05, 0.05),
		tiled=True,
		blockxsize=128,
		blockysize=128,
		compress=compress,
	) as dst:
		dst.write(data, [1, 2, 3])
		if alpha is not None:
			dst.write(alpha, 4)
			dst.colorinterp = (ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.alpha)


def _forest(seed=2344):
	rng = np.random.default_rng(seed)
	data = np.empty((3, SIZE, SIZE), dtype='uint8')
	data[0] = rng.integers(40, 120, (SIZE, SIZE))
	data[1] = rng.integers(60, 160, (SIZE, SIZE))
	data[2] = rng.integers(30, 100, (SIZE, SIZE))
	return data


def _standardise(tmp_path, data, alpha=None):
	source = tmp_path / 'source.tif'
	output = tmp_path / 'standardised.tif'
	_write(source, data, alpha)
	assert standardise_geotiff(str(source), str(output), token='test-token', dataset_id=2344)
	with rasterio.open(output) as dst:
		alpha_out = dst.read(dst.count) if dst.colorinterp[-1] == ColorInterp.alpha else None
		return dst.count, alpha_out


@pytest.mark.unit
@pytest.mark.parametrize('fill', [0, 255])
def test_standardised_copy_masks_black_or_white_collar(tmp_path, fill):
	footprint = _footprint()
	data = _forest()
	data[:, ~footprint] = fill

	count, alpha = _standardise(tmp_path, data)

	assert count == 4
	assert np.all(alpha[~footprint] == 0)
	assert np.all(alpha[_footprint(margin=4)] == 255)


@pytest.mark.unit
def test_lossy_collar_noise_is_still_masked(tmp_path):
	footprint = _footprint()
	data = _forest()
	rng = np.random.default_rng(1)
	data[:, ~footprint] = rng.integers(0, 5, (3, int((~footprint).sum())))

	count, alpha = _standardise(tmp_path, data)

	assert count == 4
	assert np.mean(alpha[~footprint] == 0) > 0.99


@pytest.mark.unit
def test_image_without_collar_is_left_alone(tmp_path):
	data = _forest()
	data[:, :, :20] = 30  # dark content on the edge, not fill

	count, alpha = _standardise(tmp_path, data)

	assert count == 3
	assert alpha is None


@pytest.mark.unit
def test_existing_transparency_is_kept_and_extended(tmp_path):
	footprint = _footprint()
	data = _forest()
	data[:, ~footprint] = 255  # white collar inside the declared alpha
	alpha = np.full((SIZE, SIZE), 255, dtype='uint8')
	alpha[:, :12] = 0  # declared transparent strip at the edge
	data[:, :, :12] = 0
	alpha[120:136, 120:136] = 0  # interior hole that is not fill-coloured
	data[:, 120:136, 120:136] = 0

	count, alpha_out = _standardise(tmp_path, data, alpha)

	assert count == 4
	assert np.all(alpha_out[:, :12] == 0)
	assert np.all(alpha_out[120:136, 120:136] == 0)
	assert np.mean(alpha_out[~footprint] == 0) > 0.99


@pytest.mark.unit
def test_dark_interior_content_is_not_detected_as_collar(tmp_path):
	data = _forest()
	data[:, 60:200, 60:200] = 0  # black interior feature, outline untouched
	path = tmp_path / 'interior.tif'
	_write(path, data)

	with rasterio.open(path) as src:
		assert not has_edge_fill(src)
