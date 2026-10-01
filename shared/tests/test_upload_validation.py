import json
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


_REAL_ZIPS = json.loads((Path(__file__).parent / 'fixtures' / 'real_upload_zips.json').read_text())['cases']


@pytest.mark.parametrize('case', _REAL_ZIPS, ids=[case['case'] for case in _REAL_ZIPS])
def test_real_upload_zips(case):
	"""Server rules reject exactly the real uploads that could never process."""
	if case['outcome'] == 'reject':
		with pytest.raises(UnprocessableUploadError, match=case['message']):
			check_raw_image_names(case['names'])
	else:
		check_raw_image_names(case['names'])


_REAL_GEOTIFFS = Path(__file__).parents[2] / 'frontend' / 'test' / 'fixtures' / 'geotiff' / 'upload-validation'


@pytest.mark.skipif(not _REAL_GEOTIFFS.exists(), reason='frontend fixtures are not in this image')
@pytest.mark.parametrize(
	('name', 'message'),
	[
		('rgb-real-crop.tif', None),
		('no-crs-coordinates-real-crop.tif', 'but no CRS definition'),
		('no-georeference-real-crop.tif', 'no coordinate reference system'),
	],
)
def test_real_geotiff_crops(name, message):
	if message is None:
		ensure_georeferenced_geotiff(_REAL_GEOTIFFS / name)
	else:
		with pytest.raises(UnprocessableUploadError, match=message):
			ensure_georeferenced_geotiff(_REAL_GEOTIFFS / name)


def test_rejects_vrt_without_opening_its_sources(tmp_path: Path, monkeypatch):
	"""A VRT named .tif must not make GDAL read files or URLs named inside it."""
	source = tmp_path / 'secret.tif'
	_write_tif(source, crs='EPSG:25832', transform=from_origin(412000, 5320000, 0.05, 0.05))
	vrt = tmp_path / 'upload.tif'
	vrt.write_text(
		'<VRTDataset rasterXSize="4" rasterYSize="4"><VRTRasterBand dataType="Byte" band="1"><SimpleSource>'
		f'<SourceFilename relativeToVRT="0">{source}</SourceFilename><SourceBand>1</SourceBand>'
		'</SimpleSource></VRTRasterBand></VRTDataset>'
	)
	with pytest.raises(UnprocessableUploadError, match='could not read this file'):
		ensure_georeferenced_geotiff(vrt)


def test_rejects_geotiff_whose_crs_cannot_be_parsed(tmp_path: Path, monkeypatch):
	def _raise(*_args, **_kwargs):
		raise rasterio.errors.CRSError('broken CRS')

	monkeypatch.setattr('shared.upload_validation.rasterio.open', _raise)
	with pytest.raises(UnprocessableUploadError, match='could not read this file'):
		ensure_georeferenced_geotiff(tmp_path / 'any.tif')


def test_counts_a_jpg_and_its_dng_as_one_photo():
	with pytest.raises(UnprocessableUploadError, match='only one image'):
		check_raw_image_names(['DJI_0001.JPG', 'DJI_0001.DNG'])
