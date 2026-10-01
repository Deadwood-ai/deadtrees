import zipfile
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_origin

from shared.upload_validation import (
	UnprocessableUploadError,
	check_raw_image_names,
	ensure_georeferenced_geotiff,
	ensure_processable_zip,
	is_multispectral_band,
)


@pytest.mark.parametrize(
	'name',
	['DJI_20260814112011_0103_MS_G.TIF', 'flight/DJI_0001_MS_NIR.TIF', 'IMG_180413_080658_0000_GRE.TIF', 'x_reg.tif'],
)
def test_multispectral_band_names(name):
	assert is_multispectral_band(name)


@pytest.mark.parametrize(
	'name', ['DJI_20260814112011_0103_D.JPG', 'IMG_180413_080658_0000_RGB.JPG', 'GREEN_forest.tif']
)
def test_rgb_photo_names(name):
	assert not is_multispectral_band(name)


def test_accepts_rgb_photos_next_to_bands_and_other_files():
	check_raw_image_names(['a/DJI_0001_D.JPG', 'a/DJI_0002_D.JPG', 'a/DJI_0001_MS_G.TIF', 'a/rtk.MRK', 'a/'])


def test_rejects_multispectral_only_zip():
	with pytest.raises(UnprocessableUploadError, match='only contains multispectral band images'):
		check_raw_image_names([f'DJI_{i:04d}_MS_{band}.TIF' for i in range(50) for band in ('G', 'R', 'RE', 'NIR')])


def test_rejects_zip_without_photos_ignoring_macos_metadata():
	with pytest.raises(UnprocessableUploadError, match='no drone photos'):
		check_raw_image_names(['notes.txt', '__MACOSX/._DJI_0001.JPG', '._DJI_0002.JPG', 'flight.MRK'])


def test_rejects_single_image_and_points_to_geotiff_upload():
	with pytest.raises(UnprocessableUploadError, match='upload the .tif file directly'):
		check_raw_image_names(['ortho/odm_orthophoto.tif', 'ortho/readme.txt'])


def test_accepts_two_photos():
	check_raw_image_names(['DJI_0001.JPG', 'DJI_0002.JPG'])


def test_ensure_processable_zip_reads_archive_names(tmp_path: Path):
	zip_path = tmp_path / 'bands.zip'
	with zipfile.ZipFile(zip_path, 'w') as archive:
		archive.writestr('DJI_0001_MS_G.TIF', b'band')
		archive.writestr('DJI_0001_MS_NIR.TIF', b'band')

	with pytest.raises(UnprocessableUploadError, match='multispectral'):
		ensure_processable_zip(zip_path)


def _write_tif(path: Path, crs=None, transform=None):
	profile = {'driver': 'GTiff', 'width': 4, 'height': 4, 'count': 3, 'dtype': 'uint8'}
	if crs:
		profile['crs'] = crs
	if transform:
		profile['transform'] = transform
	with rasterio.open(path, 'w', **profile) as dst:
		dst.write(np.zeros((3, 4, 4), dtype='uint8'))


def test_accepts_georeferenced_geotiff(tmp_path: Path):
	path = tmp_path / 'ortho.tif'
	_write_tif(path, crs='EPSG:25832', transform=from_origin(412000, 5320000, 0.05, 0.05))
	ensure_georeferenced_geotiff(path)


def test_rejects_geotiff_with_coordinates_but_no_crs(tmp_path: Path):
	path = tmp_path / 'ortho.tif'
	_write_tif(path, transform=from_origin(412000, 5320000, 0.05, 0.05))
	with pytest.raises(UnprocessableUploadError, match=r'origin: 412000\.0, 5320000\.0\) but no CRS definition'):
		ensure_georeferenced_geotiff(path)


def test_rejects_plain_image(tmp_path: Path):
	path = tmp_path / 'photo.tif'
	_write_tif(path)
	with pytest.raises(UnprocessableUploadError, match='no coordinate reference system'):
		ensure_georeferenced_geotiff(path)


def test_rejects_unreadable_geotiff(tmp_path: Path):
	path = tmp_path / 'broken.tif'
	path.write_bytes(b'not a tiff')
	with pytest.raises(UnprocessableUploadError, match='could not read this file'):
		ensure_georeferenced_geotiff(path)
