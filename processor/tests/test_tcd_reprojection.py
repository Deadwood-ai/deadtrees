"""The EPSG:3395 copy for tree cover is written in one pass (DT-1381)."""

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from processor.src.treecover_segmentation_oam_tcd import predict_treecover

pytestmark = pytest.mark.unit


def _ortho(path, size=1024):
	rng = np.random.default_rng(0)
	data = rng.integers(30, 220, (4, size, size)).astype(np.uint8)
	data[3] = 255
	with rasterio.open(
		path, 'w', driver='GTiff', width=size, height=size, count=4, dtype='uint8', tiled=True,
		blockxsize=256, blockysize=256, compress='deflate', crs='EPSG:32738',
		transform=from_origin(400000, 8700000, 0.1, 0.1),
	) as dst:
		dst.write(data)


def test_reprojection_matches_band_by_band_and_stays_compact(tmp_path):
	source = tmp_path / 'ortho.tif'
	_ortho(source)
	output = tmp_path / 'reprojected.tif'

	predict_treecover._reproject_orthomosaic_for_tcd(str(source), str(output))

	with rasterio.open(source) as src, rasterio.open(output) as dst:
		assert dst.crs.to_epsg() == 3395
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
