"""Choose which uploaded files ODM gets, before any ODM container runs (DT-1312).

Three input shapes made ODM fail on otherwise usable uploads:

* DJI cameras that save every frame twice, as JPG and DNG. ODM decodes the DNG with
  LibRaw, which fails on many DJI raws (DT-913), and the pair doubles the image count.
* Multispectral band images next to the RGB frames (DJI P4 Multispectral writes one RGB
  JPG plus five single-band TIFs per shot; M3M names its band files ``*_MS_*``). ODM then
  tries a multi-camera band alignment our RGB pipeline does not want.
* A few frames with a broken GPS fix (e.g. 0/0 or thousands of km away). They stretch the
  reconstruction bounds until the orthophoto raster needs hundreds of GB.

The functions here only drop files; they never edit images.
"""

from __future__ import annotations

import math
import re
import statistics
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

from shared.upload_validation import RAW_CAMERA_EXTENSIONS, TIFF_EXTENSIONS, is_multispectral_band

GPS_IFD = 0x8825
METRES_PER_DEGREE = 111_320.0
# A frame is a GPS outlier when it lies this many times further from the flight's median
# position than the median frame does, and at least OUTLIER_MIN_DISTANCE_M away.
OUTLIER_SPREAD_FACTOR = 5.0
OUTLIER_MIN_DISTANCE_M = 1000.0
# More "outliers" than this share (and more than one) is a multi-site or corridor upload, not a few broken fixes.
MAX_OUTLIER_SHARE = 0.1
MIN_IMAGES_FOR_OUTLIER_CHECK = 3
# Ground an image covers around its camera position; keeps a long thin line of positions from having ~0 area.
FOOTPRINT_MARGIN_M = 100.0
FAILED_FIX = (0.0, 0.0)
# ODM 3.6 lets DJI XMP drone-dji:Latitude/Longitude override the EXIF GPS (opendm/photo.py).
# DJI writes its XMP packet near the start of the JPEG.
_XMP_SCAN_BYTES = 2 * 1024 * 1024
_XMP_GPS_PATTERN = re.compile(
	rb'drone-dji:(?P<attr>Latitude|Longitude)\s*=\s*["\']\s*(?P<attr_value>[+-]?[\d.]+)'
	rb'|<drone-dji:(?P<element>Latitude|Longitude)>\s*(?P<element_value>[+-]?[\d.]+)'
)


class OdmInputError(Exception):
	"""The upload cannot make one orthophoto; the message says why in contributor terms."""


@dataclass
class OdmImageSelection:
	kept: list[Path]
	# Human-readable reason -> files left out for it, in the order the rules ran.
	dropped: dict[str, list[Path]] = field(default_factory=dict)
	extent_km2: float | None = None


def drop_paired_raw_images(image_files: list[Path]) -> tuple[list[Path], list[Path]]:
	"""Drop a DNG/RAW frame when a non-raw image with the same name sits next to it."""
	rendered = {(f.parent, f.stem.lower()) for f in image_files if f.suffix.lower() not in RAW_CAMERA_EXTENSIONS}
	kept, dropped = [], []
	for image_file in image_files:
		is_paired_raw = (
			image_file.suffix.lower() in RAW_CAMERA_EXTENSIONS
			and (image_file.parent, image_file.stem.lower()) in rendered
		)
		(dropped if is_paired_raw else kept).append(image_file)
	return kept, dropped


def _band_count(image_file: Path) -> int | None:
	try:
		with Image.open(image_file) as image:
			return len(image.getbands())
	except Exception:
		return None


def _is_band_image(image_file: Path) -> bool:
	"""Band files are named like M3M ``*_MS_*`` or Sequoia ``*_NIR.TIF``; P4 Multispectral writes single-band TIFs."""
	if is_multispectral_band(image_file.name):
		return True
	return image_file.suffix.lower() in TIFF_EXTENSIONS and _band_count(image_file) == 1


def drop_multispectral_bands(image_files: list[Path]) -> tuple[list[Path], list[Path]]:
	"""Drop multispectral band images; the RGB pipeline cannot use them."""
	kept, dropped = [], []
	for image_file in image_files:
		(dropped if _is_band_image(image_file) else kept).append(image_file)
	return kept, dropped


def _gps_degrees(values) -> float:
	degrees, minutes, seconds = (float(v) for v in values)
	return degrees + minutes / 60 + seconds / 3600


def _exif_gps(image_file: Path) -> dict[str, float]:
	try:
		with Image.open(image_file) as image:
			gps = image.getexif().get_ifd(GPS_IFD)
		return {
			'Latitude': _gps_degrees(gps[2]) * (-1 if gps.get(1) == 'S' else 1),
			'Longitude': _gps_degrees(gps[4]) * (-1 if gps.get(3) == 'W' else 1),
		}
	except Exception:
		return {}


def _xmp_gps(image_file: Path) -> dict[str, float]:
	try:
		with open(image_file, 'rb') as f:
			head = f.read(_XMP_SCAN_BYTES)
	except OSError:
		return {}
	found = {}
	for match in _XMP_GPS_PATTERN.finditer(head):
		name = (match['attr'] or match['element']).decode()
		try:
			found.setdefault(name, float(match['attr_value'] or match['element_value']))
		except ValueError:
			continue
	return found


def read_gps_position(image_file: Path) -> tuple[float, float] | None:
	"""The latitude/longitude ODM will use: DJI XMP over EXIF GPS, or None when unknown."""
	gps = {**_exif_gps(image_file), **_xmp_gps(image_file)}
	latitude, longitude = gps.get('Latitude'), gps.get('Longitude')
	if latitude is None or longitude is None or not (math.isfinite(latitude) and math.isfinite(longitude)):
		return None
	return latitude, longitude


def _offset_metres(origin: tuple[float, float], position: tuple[float, float]) -> tuple[float, float]:
	east = (position[1] - origin[1]) * METRES_PER_DEGREE * math.cos(math.radians(origin[0]))
	north = (position[0] - origin[0]) * METRES_PER_DEGREE
	return east, north


def drop_gps_outliers(
	positions: dict[Path, tuple[float, float]],
) -> tuple[dict[Path, tuple[float, float]], list[Path]]:
	"""Drop frames with a failed 0/0 fix and the few frames lying far from the rest of the flight.

	Failed fixes are always dropped while other frames have a real position. Distant frames
	are kept when more than one frame and more than MAX_OUTLIER_SHARE of them are distant:
	that is a real spread (several sites or a long corridor), which the extent check reports.
	"""
	valid = {f: p for f, p in positions.items() if p != FAILED_FIX}
	if not valid:
		return positions, []
	failed = [f for f in positions if f not in valid]
	distant = []
	if len(valid) >= MIN_IMAGES_FOR_OUTLIER_CHECK:
		median = (statistics.median(p[0] for p in valid.values()), statistics.median(p[1] for p in valid.values()))
		distances = {f: math.hypot(*_offset_metres(median, p)) for f, p in valid.items()}
		limit = max(OUTLIER_MIN_DISTANCE_M, OUTLIER_SPREAD_FACTOR * statistics.median(distances.values()))
		distant = [f for f in valid if distances[f] > limit]
		if len(distant) > max(1, MAX_OUTLIER_SHARE * len(valid)):
			distant = []
	outliers = failed + distant
	return {f: p for f, p in positions.items() if f not in outliers}, outliers


def gps_extent_km2(positions: list[tuple[float, float]]) -> float:
	"""Area of the bounding box around the image positions plus each image's footprint, in km²."""
	south_west = (min(p[0] for p in positions), min(p[1] for p in positions))
	north_east = (max(p[0] for p in positions), max(p[1] for p in positions))
	east, north = _offset_metres(south_west, north_east)
	return (abs(east) + 2 * FOOTPRINT_MARGIN_M) * (abs(north) + 2 * FOOTPRINT_MARGIN_M) / 1e6


def select_odm_images(image_files: list[Path], max_extent_km2: float) -> OdmImageSelection:
	"""Apply the DNG, multispectral and GPS-outlier rules, then check the mosaic extent.

	Raises OdmInputError when only multispectral band images remain, or when the remaining
	images span more than ``max_extent_km2``: one ODM run cannot mosaic that area within its
	memory, so the upload needs to be split.
	"""
	selection = OdmImageSelection(kept=list(image_files))

	selection.kept, paired_raw = drop_paired_raw_images(selection.kept)
	if paired_raw:
		selection.dropped['raw (DNG) duplicates of JPG frames'] = paired_raw

	selection.kept, bands = drop_multispectral_bands(selection.kept)
	if bands:
		if not selection.kept:
			raise OdmInputError(
				'The upload contains only multispectral band images; an RGB orthomosaic needs RGB photos'
			)
		selection.dropped['multispectral band images'] = bands

	positions = {f: p for f in selection.kept if (p := read_gps_position(f)) is not None}
	positions, outliers = drop_gps_outliers(positions)
	if outliers:
		selection.dropped['images with a GPS position far from the rest of the flight'] = outliers
		selection.kept = [f for f in selection.kept if f not in outliers]

	if positions:
		selection.extent_km2 = gps_extent_km2(list(positions.values()))
		if selection.extent_km2 > max_extent_km2:
			raise OdmInputError(
				f'The images span {selection.extent_km2:.0f} km², more than the {max_extent_km2:g} km² one '
				'orthomosaic can cover. Please upload each site or flight area separately.'
			)
	return selection
