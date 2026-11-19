"""Input rules that decide whether an upload can be processed at all.

The API applies them when an upload completes and the processor reuses the
GeoTIFF message, so a contributor sees the same reason in both places. The
browser mirrors the name rules in `frontend/src/utils/uploadRules.ts`; keep the
two in step. Rules here only reject inputs the processor is certain to fail
on; anything merely risky is a browser warning, not a rejection.

The browser cannot see how many bands a TIFF in a ZIP has, so the API alone
rejects a ZIP whose only photos are single-band TIFFs (DT-1584).
"""

import io
import math
import re
import struct
import zipfile
import zlib
from pathlib import Path, PurePosixPath
from typing import Iterable

import rasterio
from rasterio.errors import CRSError, RasterioError
from rasterio.transform import Affine

from shared.photo_gps import has_gps_position

# Photo formats the ODM run accepts from a raw-image ZIP.
RAW_IMAGE_EXTENSIONS = frozenset({'.jpg', '.jpeg', '.png', '.tif', '.tiff', '.dng', '.raw', '.bmp', '.webp'})
RAW_CAMERA_EXTENSIONS = frozenset({'.dng', '.raw'})
TIFF_EXTENSIONS = frozenset({'.tif', '.tiff'})

# Single-band captures from multispectral cameras: DJI Mavic 3M (`*_MS_G.TIF`)
# and Parrot Sequoia (`*_GRE.TIF`, `*_NIR.TIF`, `*_RED.TIF`, `*_REG.TIF`).
_MULTISPECTRAL_BAND = re.compile(r'(_MS_)|(_(GRE|NIR|RED|REG)\.TIFF?$)', re.IGNORECASE)


MULTISPECTRAL_ONLY_MESSAGE = (
	'This ZIP only contains multispectral band images (for example *_MS_G.TIF or *_NIR.TIF). '
	'deadtrees.earth needs the RGB photos from the flight. '
	'Add the RGB JPGs, or upload an RGB orthomosaic as a GeoTIFF.'
)


NO_GPS_MESSAGE = (
	'None of the checked photos in this ZIP has a GPS position, so they cannot be placed on the map. '
	'Upload the original drone photos with their GPS data. '
	'If these files are already orthomosaics, upload each .tif directly as a GeoTIFF.'
)
# Photos read for GPS, spread evenly over the ZIP, so the check stays a few reads long.
GPS_SAMPLE_SIZE = 5
# How far into a compressed photo the check may read. Some TIFFs keep their metadata
# at the very end (dataset 15632: 485 MB each); a photo whose metadata lies further
# counts as unreadable rather than costing the upload a minute of decompression.
GPS_READ_LIMIT_BYTES = 1024 * 1024 * 1024


class UnprocessableUploadError(ValueError):
	"""The upload is valid as a file but cannot produce a result."""


def is_multispectral_band(file_name: str) -> bool:
	return bool(_MULTISPECTRAL_BAND.search(PurePosixPath(file_name).name))


# A TIFF's first IFD sits right after the 8-byte header in camera files. Reading this much of
# each ZIP entry finds it without inflating whole 8 MB band images.
_TIFF_HEAD_BYTES = 64 * 1024
_SAMPLES_PER_PIXEL_TAG = 277


def tiff_samples_per_pixel(head: bytes) -> int | None:
	"""SamplesPerPixel of a classic TIFF's first image, or None when `head` does not hold its IFD.

	One sample per pixel is what the processor's Pillow check sees as a one-band image
	(`processor/src/utils/odm_inputs.py`), so both sides agree on band files.
	"""
	if head[:4] == b'II*\x00':
		order = '<'
	elif head[:4] == b'MM\x00*':
		order = '>'
	else:
		return None
	if len(head) < 8:
		return None
	(ifd_offset,) = struct.unpack(f'{order}I', head[4:8])
	if ifd_offset + 2 > len(head):
		return None
	(entry_count,) = struct.unpack(f'{order}H', head[ifd_offset : ifd_offset + 2])
	entries_end = ifd_offset + 2 + 12 * entry_count
	if entries_end > len(head):
		return None
	for start in range(ifd_offset + 2, entries_end, 12):
		tag, value_type = struct.unpack(f'{order}HH', head[start : start + 4])
		if tag == _SAMPLES_PER_PIXEL_TAG:
			value_format = {3: 'H', 4: 'I'}.get(value_type)
			if value_format is None:
				return None
			(samples,) = struct.unpack(
				f'{order}{value_format}', head[start + 8 : start + 8 + struct.calcsize(value_format)]
			)
			return samples
	# The TIFF 6.0 default when the tag is missing.
	return 1


def raw_image_names(entry_names: Iterable[str]) -> list[str]:
	"""Return ZIP entries that are photos, skipping folders and macOS metadata."""
	return [
		name
		for name in entry_names
		if not name.endswith('/')
		and '__MACOSX' not in name
		and not PurePosixPath(name).name.startswith('._')
		and PurePosixPath(name).suffix.lower() in RAW_IMAGE_EXTENSIONS
	]


def _photo_key(name: str) -> str:
	"""A JPG and its DNG twin are one photo."""
	return str(PurePosixPath(name).with_suffix('')).lower()


def rgb_photo_names(entry_names: Iterable[str]) -> list[str]:
	"""One entry per photo: RGB images only, preferring a JPG over its DNG twin, sorted by name."""
	photos: dict[str, str] = {}
	for name in sorted(raw_image_names(entry_names)):
		if is_multispectral_band(name):
			continue
		key = _photo_key(name)
		if key not in photos or PurePosixPath(photos[key]).suffix.lower() in RAW_CAMERA_EXTENSIONS:
			photos[key] = name
	return sorted(photos.values())


def gps_sample(photo_names: list[str], size: int = GPS_SAMPLE_SIZE) -> list[str]:
	"""Up to ``size`` photos spread evenly from first to last, so one bad stretch cannot decide alone."""
	if len(photo_names) <= size:
		return list(photo_names)
	step = (len(photo_names) - 1) / (size - 1)
	# Rounds halves up like the browser's Math.round, so both pick the same photos.
	return [photo_names[math.floor(i * step + 0.5)] for i in range(size)]


def check_raw_image_names(entry_names: Iterable[str]) -> None:
	"""Reject a raw-image ZIP that cannot be stitched into an orthomosaic."""
	images = raw_image_names(entry_names)
	rgb_images = [name for name in images if not is_multispectral_band(name)]

	if not rgb_images and images:
		raise UnprocessableUploadError(MULTISPECTRAL_ONLY_MESSAGE)
	if not rgb_images:
		raise UnprocessableUploadError(
			'This ZIP contains no drone photos we can process (JPG, PNG, TIFF or DNG). '
			'Check that the photos are inside the archive.'
		)
	# A JPG and its DNG twin are one photo; the processor drops the DNG.
	if len({_photo_key(name) for name in rgb_images}) == 1:
		raise UnprocessableUploadError(
			'This ZIP contains only one image, and an orthomosaic needs many overlapping photos. '
			'If this image is already an orthomosaic, upload the .tif file directly as a GeoTIFF.'
		)


def _check_tiff_band_counts(archive: zipfile.ZipFile) -> None:
	"""Reject a ZIP whose only photos are single-band TIFFs; ODM gets no image from it.

	Reads only the head of each TIFF and stops at the first one that is not clearly
	single-band, so a usable upload costs one header read.
	"""
	photos = [name for name in raw_image_names(archive.namelist()) if not is_multispectral_band(name)]
	if any(PurePosixPath(name).suffix.lower() not in TIFF_EXTENSIONS for name in photos):
		return
	for name in photos:
		try:
			with archive.open(name) as entry:
				head = entry.read(_TIFF_HEAD_BYTES)
		except (RuntimeError, OSError, zipfile.BadZipFile, zlib.error):
			# Encrypted or damaged entries are not this rule's call; leave them to the processor.
			return
		if tiff_samples_per_pixel(head) != 1:
			return
	raise UnprocessableUploadError(MULTISPECTRAL_ONLY_MESSAGE)


class _BoundedReader(io.RawIOBase):
	"""A ZIP entry that reads as empty past ``limit`` and seeks without decompressing.

	Parsers seek freely (Pillow asks a TIFF for its size by seeking to the end); a
	real seek in a compressed entry decompresses everything before the target. This
	view only moves the entry when bytes within the limit are read.
	"""

	def __init__(self, raw, size: int, limit: int):
		self._raw, self._size, self._limit, self._position = raw, size, limit, 0

	def readable(self) -> bool:
		return True

	def seekable(self) -> bool:
		return True

	def tell(self) -> int:
		return self._position

	def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
		base = {io.SEEK_SET: 0, io.SEEK_CUR: self._position, io.SEEK_END: self._size}[whence]
		self._position = max(base + offset, 0)
		return self._position

	def readinto(self, buffer) -> int:
		count = min(len(buffer), min(self._limit, self._size) - self._position)
		if count <= 0:
			return 0
		if self._raw.tell() != self._position:
			self._raw.seek(self._position)
		data = self._raw.read(count)
		buffer[: len(data)] = data
		self._position += len(data)
		return len(data)


def photos_lack_gps(answers: Iterable[bool | None]) -> bool:
	"""True when photos were checked and every one was read and has no GPS position.

	ODM cannot place such photos, and the platform has no ground control point
	input. A photo whose metadata cannot be read never counts against the upload.
	"""
	answers = list(answers)
	return bool(answers) and all(answer is False for answer in answers)


def check_photo_positions(archive: zipfile.ZipFile, read_limit: int = GPS_READ_LIMIT_BYTES) -> None:
	"""Reject a ZIP whose sampled photos all lack a GPS position."""
	answers = []
	for name in gps_sample(rgb_photo_names(archive.namelist())):
		try:
			with archive.open(name) as entry:
				view = _BoundedReader(entry, archive.getinfo(name).file_size, read_limit)
				answers.append(has_gps_position(io.BufferedReader(view)))
		except (RuntimeError, OSError, zipfile.BadZipFile, zlib.error):
			# Encrypted or damaged entries are not this rule's call; leave them to the processor.
			return
		if answers[-1] is not False:
			return
	if photos_lack_gps(answers):
		raise UnprocessableUploadError(NO_GPS_MESSAGE)


def ensure_processable_zip(zip_path: Path) -> None:
	with zipfile.ZipFile(zip_path, 'r') as archive:
		check_raw_image_names(archive.namelist())
		_check_tiff_band_counts(archive)
		check_photo_positions(archive)


def ensure_processable_upload(path: Path) -> None:
	"""Apply the rules for the upload type the API derives from the file extension."""
	suffix = path.suffix.lower()
	if suffix == '.zip':
		ensure_processable_zip(path)
	elif suffix in TIFF_EXTENSIONS:
		ensure_georeferenced_geotiff(path)


def missing_crs_message(src) -> str | None:
	"""Explain why an open rasterio dataset has no usable CRS, or return None."""
	if src.crs:
		return None

	transform = src.transform
	if transform != Affine.identity() and (transform.c or transform.f):
		return (
			f'File has coordinates (origin: {transform.c:.1f}, {transform.f:.1f}) but no CRS definition. '
			'The projection system is unknown. Please re-export the GeoTIFF with its CRS embedded (for example EPSG:25832).'
		)
	return (
		'File has no coordinate reference system (CRS) or georeferencing. '
		'This appears to be a plain image, not a georeferenced orthomosaic. '
		'Please upload a GeoTIFF with its CRS embedded.'
	)


def ensure_georeferenced_geotiff(path: Path) -> None:
	"""Reject a GeoTIFF the processor would refuse for a missing CRS."""
	try:
		# Only the GeoTIFF driver: formats such as VRT can make GDAL fetch other
		# files or URLs named inside the upload while it is being opened.
		with rasterio.open(path, driver='GTiff') as src:
			problem = missing_crs_message(src)
	except (RasterioError, CRSError) as exc:
		raise UnprocessableUploadError(
			'We could not read this file as a GeoTIFF. Please upload a valid GeoTIFF.'
		) from exc
	if problem:
		raise UnprocessableUploadError(problem)
