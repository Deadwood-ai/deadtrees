import io
import json
import zipfile
from pathlib import Path

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.transform import from_origin

from shared.upload_validation import (
	UnprocessableUploadError,
	_BoundedReader,
	check_photo_positions,
	check_raw_image_names,
	ensure_georeferenced_geotiff,
	ensure_processable_upload,
	ensure_processable_zip,
	gps_sample,
	is_multispectral_band,
	rgb_photo_names,
	tiff_samples_per_pixel,
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


def _tiff_bytes(mode: str) -> bytes:
	buffer = io.BytesIO()
	Image.new(mode, (4, 4)).save(buffer, format='TIFF')
	return buffer.getvalue()


def _zip_with(tmp_path: Path, entries: dict[str, bytes]) -> Path:
	zip_path = tmp_path / 'upload.zip'
	with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
		for name, data in entries.items():
			archive.writestr(name, data)
	return zip_path


@pytest.mark.parametrize('mode', ['1', 'L', 'P', 'I;16', 'I;16B', 'F', 'LA', 'RGB', 'RGBA', 'CMYK'])
def test_tiff_header_agrees_with_the_processor_band_count(mode):
	"""The processor counts bands with Pillow; the header read must say the same."""
	data = _tiff_bytes(mode)
	with Image.open(io.BytesIO(data)) as image:
		single_band = len(image.getbands()) == 1
	assert (tiff_samples_per_pixel(data) == 1) == single_band


def test_tiff_header_read_gives_up_when_the_ifd_is_not_in_the_head():
	data = _tiff_bytes('L')
	assert tiff_samples_per_pixel(data[:9]) is None
	assert tiff_samples_per_pixel(b'not a tiff') is None
	assert tiff_samples_per_pixel(b'II*\x00ab') is None


def test_leaves_encrypted_tiff_entries_to_the_processor(tmp_path: Path, monkeypatch):
	zip_path = _zip_with(tmp_path, {f'DJI_{i:04d}.TIF': _tiff_bytes('L') for i in range(11, 16)})

	def _encrypted(*_args, **_kwargs):
		raise RuntimeError('File is encrypted, password required for extraction')

	monkeypatch.setattr(zipfile.ZipFile, 'open', _encrypted)
	ensure_processable_zip(zip_path)


def test_rejects_zip_of_single_band_tiffs_with_rgb_like_names(tmp_path: Path):
	"""DJI P4 Multispectral band files look like RGB frames by name (DT-1584)."""
	zip_path = _zip_with(tmp_path, {f'flight/DJI_{i:04d}.TIF': _tiff_bytes('L') for i in range(11, 16)})

	with pytest.raises(UnprocessableUploadError, match='only contains multispectral band images'):
		ensure_processable_zip(zip_path)


# A DJI XMP position, so a test about bands is not decided by the GPS rule (DT-1582).
_DJI_POSITION = b'<rdf:Description drone-dji:Latitude="+48.0" drone-dji:Longitude="+7.85"/>'


def test_accepts_zip_of_rgb_tiffs_after_band_files(tmp_path: Path):
	entries = {f'DJI_{i:04d}.TIF': _tiff_bytes('L') for i in range(11, 16)}
	entries['DJI_0020.TIF'] = _tiff_bytes('RGB') + _DJI_POSITION
	ensure_processable_zip(_zip_with(tmp_path, entries))


def test_accepts_single_band_tiffs_next_to_rgb_jpgs(tmp_path: Path):
	entries = {f'DJI_{i:04d}.TIF': _tiff_bytes('L') for i in range(11, 16)}
	entries.update({'DJI_0010.JPG': b'jpg', 'DJI_0020.JPG': b'jpg'})
	ensure_processable_zip(_zip_with(tmp_path, entries))


def test_accepts_tiffs_whose_bands_cannot_be_read(tmp_path: Path):
	"""An unreadable TIFF may still reach ODM, so it never counts as a band image."""
	ensure_processable_zip(_zip_with(tmp_path, {'DJI_0001.TIF': b'tiff', 'DJI_0002.TIF': b'tiff'}))


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


_PHOTO_FIXTURES = Path(__file__).parents[2] / 'frontend' / 'test' / 'fixtures' / 'photo-gps'
needs_photo_fixtures = pytest.mark.skipif(not _PHOTO_FIXTURES.exists(), reason='frontend fixtures are not in this image')


def test_gps_sample_spreads_over_the_whole_flight():
	names = [f'{i:03d}.JPG' for i in range(101)]
	assert gps_sample(names) == ['000.JPG', '025.JPG', '050.JPG', '075.JPG', '100.JPG']
	assert gps_sample(names[:3]) == names[:3]
	# Halves round up, matching the browser's Math.round (uploadRules.test.ts).
	assert gps_sample([f'{i:02d}.JPG' for i in range(11)]) == ['00.JPG', '03.JPG', '05.JPG', '08.JPG', '10.JPG']


def test_rgb_photo_names_prefers_the_jpg_of_a_dng_pair_and_skips_bands():
	names = ['a/DJI_0002.DNG', 'a/DJI_0001.DNG', 'a/DJI_0001.JPG', 'a/DJI_0001_MS_G.TIF', 'a/notes.txt']
	assert rgb_photo_names(names) == ['a/DJI_0001.JPG', 'a/DJI_0002.DNG']


def _zip_of(path: Path, photos: dict[str, bytes], compression=zipfile.ZIP_DEFLATED) -> Path:
	with zipfile.ZipFile(path, 'w', compression) as archive:
		for name, data in photos.items():
			archive.writestr(name, data)
	return path


@needs_photo_fixtures
@pytest.mark.filterwarnings('ignore::UserWarning')
@pytest.mark.parametrize('case', json.loads((_PHOTO_FIXTURES / 'manifest.json').read_text())['zips'] if _PHOTO_FIXTURES.exists() else [])
def test_photo_gps_zip_fixtures(case):
	"""The browser test reads the same ZIPs and expects the same outcome."""
	if case['outcome'] == 'reject':
		with pytest.raises(UnprocessableUploadError, match='None of the checked photos'):
			ensure_processable_zip(_PHOTO_FIXTURES / case['file'])
	else:
		ensure_processable_zip(_PHOTO_FIXTURES / case['file'])


@needs_photo_fixtures
def test_one_unreadable_photo_keeps_the_upload(tmp_path: Path):
	no_gps = (_PHOTO_FIXTURES / 'no-exif.jpg').read_bytes()
	photos = {f'IMG_{i}.JPG': no_gps for i in range(4)} | {'IMG_9.JPG': b'not a photo'}
	with zipfile.ZipFile(_zip_of(tmp_path / 'mixed.zip', photos)) as archive:
		check_photo_positions(archive)


@needs_photo_fixtures
@pytest.mark.filterwarnings('ignore::UserWarning')
def test_metadata_beyond_the_read_limit_never_rejects(tmp_path: Path):
	"""A TIFF whose metadata follows its pixels (dataset 15632) is only judged when the limit reaches it."""
	tif = (_PHOTO_FIXTURES / 'no-gps-metadata-at-end.tif').read_bytes()
	path = _zip_of(tmp_path / 'tiles.zip', {f'{i}.tif': tif for i in range(3)})
	with zipfile.ZipFile(path) as archive:
		check_photo_positions(archive, read_limit=64)
		with pytest.raises(UnprocessableUploadError, match='upload each .tif directly as a GeoTIFF'):
			check_photo_positions(archive, read_limit=len(tif))


@needs_photo_fixtures
def test_ensure_processable_upload_picks_the_rules_by_extension(tmp_path: Path):
	no_gps = (_PHOTO_FIXTURES / 'no-exif.jpg').read_bytes()
	with pytest.raises(UnprocessableUploadError, match='GPS position'):
		ensure_processable_upload(_zip_of(tmp_path / 'flight.ZIP', {'a.jpg': no_gps, 'b.jpg': no_gps}))
	plain = tmp_path / 'photo.tif'
	_write_tif(plain)
	with pytest.raises(UnprocessableUploadError, match='no coordinate reference system'):
		ensure_processable_upload(plain)
	ensure_processable_upload(tmp_path / 'labels.gpkg')


@needs_photo_fixtures
@pytest.mark.filterwarnings('ignore::UserWarning')
def test_gps_block_beyond_the_read_limit_never_rejects(tmp_path: Path):
	"""IFD0 is readable but the GPS block lies past the limit: Pillow returns an empty block, not an error."""
	tif = (_PHOTO_FIXTURES / 'gps-ifd-first.tif').read_bytes()
	path = _zip_of(tmp_path / 'flight.zip', {f'{i}.tif': tif for i in range(3)})
	with zipfile.ZipFile(path) as archive:
		check_photo_positions(archive, read_limit=134)


class _CountingStream(io.BytesIO):
	def __init__(self, data: bytes):
		super().__init__(data)
		self.bytes_read = 0
		self.seeks = 0

	def read(self, size=-1):
		data = super().read(size)
		self.bytes_read += len(data)
		return data

	def seek(self, offset, whence=io.SEEK_SET):
		self.seeks += 1
		return super().seek(offset, whence)


@needs_photo_fixtures
@pytest.mark.parametrize('name', ['gps-big-endian.tif', 'no-gps-metadata-at-end.tif', 'gps.jpg'])
def test_bounded_reader_decompresses_each_byte_once(name):
	"""Parser seeks never reach the entry, so a backward jump cannot restart its decompression."""
	data = (_PHOTO_FIXTURES / name).read_bytes()
	raw = _CountingStream(data)
	raw.seeks = 0
	view = _BoundedReader(raw, len(data), limit=len(data))

	from shared.photo_gps import has_gps_position

	has_gps_position(io.BufferedReader(view))

	assert raw.seeks == 0
	assert raw.bytes_read <= len(data)
