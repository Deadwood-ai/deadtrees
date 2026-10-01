"""Input rules that decide whether an upload can be processed at all.

The API applies them when an upload completes and the processor reuses the
GeoTIFF message, so a contributor sees the same reason in both places. The
browser mirrors these rules in `frontend/src/utils/uploadRules.ts`; keep the
two in step. Rules here only reject inputs the processor is certain to fail
on; anything merely risky is a browser warning, not a rejection.
"""

import re
import zipfile
from pathlib import Path, PurePosixPath
from typing import Iterable

import rasterio
from rasterio.errors import CRSError, RasterioError
from rasterio.transform import Affine

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


class UnprocessableUploadError(ValueError):
	"""The upload is valid as a file but cannot produce a result."""


def is_multispectral_band(file_name: str) -> bool:
	return bool(_MULTISPECTRAL_BAND.search(PurePosixPath(file_name).name))


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
	if len({str(PurePosixPath(name).with_suffix('')).lower() for name in rgb_images}) == 1:
		raise UnprocessableUploadError(
			'This ZIP contains only one image, and an orthomosaic needs many overlapping photos. '
			'If this image is already an orthomosaic, upload the .tif file directly as a GeoTIFF.'
		)


def ensure_processable_zip(zip_path: Path) -> None:
	with zipfile.ZipFile(zip_path, 'r') as archive:
		check_raw_image_names(archive.namelist())


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
