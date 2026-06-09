import numpy as np
from PIL import Image
import pytest
import rasterio
from rasterio.transform import from_origin

from processor.src.thumbnail.thumbnail import _to_uint8_rgb, calculate_thumbnail


@pytest.mark.unit
def test_calculate_thumbnail_accepts_uint16_rgb_geotiff(tmp_path):
	input_path = tmp_path / 'uint16_rgb.tif'
	output_path = tmp_path / 'thumbnail.jpg'

	width = 32
	height = 32
	gradient = np.linspace(0, 1024, width * height, dtype=np.uint16).reshape(height, width)
	data = np.stack([gradient, np.flipud(gradient), np.full_like(gradient, 512)])

	with rasterio.open(
		input_path,
		'w',
		driver='GTiff',
		height=height,
		width=width,
		count=3,
		dtype='uint16',
		transform=from_origin(10, 10, 1, 1),
	) as dataset:
		dataset.write(data)

	calculate_thumbnail(str(input_path), str(output_path), size=(16, 16), dataset_id=10388)

	with Image.open(output_path) as thumbnail:
		pixels = np.asarray(thumbnail)
		assert thumbnail.mode == 'RGB'
		assert thumbnail.size == (16, 16)
		assert pixels.max() > pixels.min()
		assert pixels.mean() > 0


@pytest.mark.unit
def test_uint16_rgb_scaling_ignores_masked_nodata_pixels():
	rgb = np.full((3, 4, 4), 65535, dtype=np.uint16)
	valid_mask = np.zeros((4, 4), dtype=bool)
	valid_mask[1:3, 1:3] = True
	rgb[:, 1:3, 1:3] = np.array(
		[
			[[0, 256], [512, 1024]],
			[[1024, 512], [256, 0]],
			[[128, 256], [512, 768]],
		],
		dtype=np.uint16,
	)

	converted = _to_uint8_rgb(rgb, valid_mask=valid_mask)

	assert converted[:, 1:3, 1:3].max() > 200


@pytest.mark.unit
def test_non_uint8_rgb_scaling_stretches_normalized_float_values():
	rgb = np.array(
		[
			[[0.0, 0.25], [0.5, 1.0]],
			[[1.0, 0.5], [0.25, 0.0]],
			[[0.125, 0.25], [0.5, 0.75]],
		],
		dtype=np.float32,
	)

	converted = _to_uint8_rgb(rgb)

	assert converted.dtype == np.uint8
	assert converted.max() > 200
	assert converted.min() < 10
