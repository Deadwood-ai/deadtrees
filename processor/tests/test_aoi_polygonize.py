import numpy as np
import pytest
import rasterio
from rasterio.enums import ColorInterp
from rasterio.transform import from_origin
from shapely.ops import unary_union

from processor.src.aoi_segmentation_v1.inference import aoi_inference
from processor.src.utils.segmentation import reproject_polygons


def _write_mask(path, mask, cell_m=0.1):
	with rasterio.open(
		path,
		'w',
		driver='GTiff',
		height=mask.shape[0],
		width=mask.shape[1],
		count=1,
		dtype=np.uint8,
		crs='EPSG:32632',
		transform=from_origin(400000, 5300000, cell_m, cell_m),
	) as dst:
		dst.write(mask, 1)


@pytest.mark.unit
def test_large_mask_is_polygonized_from_a_reduced_copy_with_the_same_outline(tmp_path, monkeypatch):
	mask = np.zeros((1000, 1200), dtype=np.uint8)
	mask[100:900, 150:1050] = 1  # 80 m x 90 m inside-AOI block at 10 cm
	path = tmp_path / 'mask.tif'
	_write_mask(path, mask)
	logged = []

	full = unary_union(aoi_inference.polygonize_inside_aoi(str(path), lambda message, **extra: logged.append(extra)))
	monkeypatch.setattr(aoi_inference, 'MAX_POLYGONIZE_PIXELS', 50_000)
	reduced = unary_union(aoi_inference.polygonize_inside_aoi(str(path), lambda message, **extra: logged.append(extra)))

	assert full.area == pytest.approx(80 * 90)
	assert reduced.symmetric_difference(full).area < 0.02 * full.area
	assert logged[1]['reduction_factor'] == 5
	assert logged[1]['cell_size_m'] == pytest.approx(0.5)


@pytest.mark.unit
def test_empty_mask_has_no_aoi_polygons(tmp_path, monkeypatch):
	path = tmp_path / 'mask.tif'
	_write_mask(path, np.zeros((400, 400), dtype=np.uint8))
	monkeypatch.setattr(aoi_inference, 'MAX_POLYGONIZE_PIXELS', 10_000)

	assert aoi_inference.polygonize_inside_aoi(str(path), lambda message, **extra: None) == []


@pytest.mark.unit
def test_ortho_smaller_than_one_tile_gets_its_valid_data_footprint_without_the_model(tmp_path):
	# 30 m x 20 m plot at 2 cm, an alpha band marking a 10 m x 20 m nodata strip
	height, width = 1000, 1500
	alpha = np.full((height, width), 255, dtype=np.uint8)
	alpha[:, 1000:] = 0
	path = tmp_path / 'small_ortho.tif'
	with rasterio.open(
		path,
		'w',
		driver='GTiff',
		height=height,
		width=width,
		count=4,
		dtype=np.uint8,
		crs='EPSG:32632',
		transform=from_origin(400000, 5300000, 0.02, 0.02),
	) as dst:
		dst.write(np.full((3, height, width), 120, dtype=np.uint8), [1, 2, 3])
		dst.write(alpha, 4)
		dst.colorinterp = [ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.alpha]
	logged = []

	# No model: the small-ortho path must not run inference.
	model = object.__new__(aoi_inference.AOIInference)
	polygons = model.inference(str(path), log=lambda message, **extra: logged.append(message))

	assert len(polygons) == 1
	(footprint,) = reproject_polygons(polygons, 'EPSG:4326', 'EPSG:32632')
	assert footprint.area == pytest.approx(20 * 20, rel=0.05)
	assert any('footprint' in message for message in logged)
