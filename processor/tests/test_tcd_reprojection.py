"""Tree cover runs on 0.1 m ground pixels in the local UTM zone (DT-1381, DT-1382)."""

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from processor.src.treecover_segmentation_oam_tcd import predict_treecover

pytestmark = pytest.mark.unit


def _ortho(path, size=1024, compress='deflate', crs='EPSG:32738', transform=from_origin(400000, 8700000, 0.1, 0.1)):
	rng = np.random.default_rng(0)
	data = rng.integers(30, 220, (4, size, size)).astype(np.uint8)
	data[3] = 255
	with rasterio.open(
		path, 'w', driver='GTiff', width=size, height=size, count=4, dtype='uint8', tiled=True,
		blockxsize=256, blockysize=256, compress=compress, crs=crs, transform=transform,
	) as dst:
		dst.write(data)


def test_reprojection_matches_band_by_band_and_stays_compact(tmp_path):
	source = tmp_path / 'ortho.tif'
	_ortho(source)
	output = tmp_path / 'reprojected.tif'

	predict_treecover._reproject_orthomosaic_for_tcd(str(source), str(output))

	with rasterio.open(source) as src, rasterio.open(output) as dst:
		assert dst.crs.to_epsg() == 32738
		assert dst.count == 4
		for band in range(1, 5):
			expected = np.zeros((dst.height, dst.width), dtype=np.uint8)
			rasterio.warp.reproject(
				source=rasterio.band(src, band), destination=expected,
				src_transform=src.transform, src_crs=src.crs,
				dst_transform=dst.transform, dst_crs=dst.crs,
				resampling=rasterio.warp.Resampling.bilinear,
			)
			assert np.array_equal(dst.read(band), expected)
	# Rewriting compressed tiles once per band made the copy grow well past the source.
	assert output.stat().st_size < 1.5 * source.stat().st_size


@pytest.mark.parametrize('compress', ['zstd', 'deflate', 'lzw', None])
def test_lossless_copy_uses_a_predictor(tmp_path, compress):
	source = tmp_path / 'ortho.tif'
	_ortho(source, size=512, compress=compress)
	output = tmp_path / 'reprojected.tif'

	predict_treecover._reproject_orthomosaic_for_tcd(str(source), str(output))

	with rasterio.open(output) as dst:
		assert dst.profile['compress'] == 'zstd'
		assert dst.tags(ns='IMAGE_STRUCTURE').get('PREDICTOR') == '2'


@pytest.mark.parametrize('compress', ['jpeg', 'webp', 'lerc_zstd'])
def test_lossy_copy_keeps_its_codec(tmp_path, compress):
	source = tmp_path / 'ortho.tif'
	_ortho(source, size=512, compress=compress)
	output = tmp_path / 'reprojected.tif'

	predict_treecover._reproject_orthomosaic_for_tcd(str(source), str(output))

	with rasterio.open(output) as dst:
		assert dst.profile['compress'] == compress


def test_ortho_already_on_the_grid_is_used_without_a_copy(tmp_path):
	source = tmp_path / 'ortho.tif'
	_ortho(source, size=512)
	output = tmp_path / 'reprojected.tif'

	assert predict_treecover._tcd_input(str(source), str(output)) == str(source)
	assert not output.exists()


def test_high_latitude_ortho_gets_ground_true_10_cm_pixels(tmp_path):
	"""A Web Mercator ortho at 64°N: 0.1 m on the ground, not 0.1 Mercator units (DT-1382)."""
	source = tmp_path / 'ortho.tif'
	# 0.1 m on the ground at 64°N is about 0.228 Web Mercator units.
	x, y = rasterio.warp.transform('EPSG:4326', 'EPSG:3857', [-147.0], [64.0])
	_ortho(source, size=512, crs='EPSG:3857', transform=from_origin(x[0], y[0], 0.228, 0.228))
	output = tmp_path / 'reprojected.tif'

	assert predict_treecover._tcd_input(str(source), str(output)) == str(output)

	with rasterio.open(output) as dst:
		assert dst.crs.to_epsg() == 32606
		assert dst.res == pytest.approx((0.1, 0.1))
		# The ortho covers about 51 m per side, so about 510 pixels, not EPSG:3395's ~1170.
		assert 480 < dst.width < 560
