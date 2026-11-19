"""Where a drone photo was taken, read the way ODM reads it (DT-1312, DT-1582).

ODM 3.6 places a photo by its EXIF GPS tags, and lets DJI's XMP
``drone-dji:Latitude``/``Longitude`` override them (opendm/photo.py). The processor
uses the position to drop broken fixes; the upload rules use its absence to reject
photos that ODM could never place on the map.

Every function takes a path or an open binary file, such as a ZIP entry, so an upload
can be checked without unpacking it.
"""

from __future__ import annotations

import math
import re
import warnings
from pathlib import Path
from typing import BinaryIO

from PIL import Image

GPS_IFD = 0x8825
GPS_LATITUDE = 2
GPS_LONGITUDE = 4
# DJI writes its XMP packet near the start of the JPEG.
XMP_SCAN_BYTES = 2 * 1024 * 1024
_XMP_GPS_PATTERN = re.compile(
	rb'drone-dji:(?P<attr>Latitude|Longitude)\s*=\s*["\']\s*(?P<attr_value>[+-]?[\d.]+)'
	rb'|<drone-dji:(?P<element>Latitude|Longitude)>\s*(?P<element_value>[+-]?[\d.]+)'
)

Photo = Path | BinaryIO


def _read_head(photo: Photo) -> bytes:
	if isinstance(photo, Path):
		with open(photo, 'rb') as f:
			return f.read(XMP_SCAN_BYTES)
	photo.seek(0)
	return photo.read(XMP_SCAN_BYTES)


def _open_image(photo: Photo) -> Image.Image:
	if not isinstance(photo, Path):
		photo.seek(0)
	return Image.open(photo)


def _gps_degrees(values) -> float:
	degrees, minutes, seconds = (float(v) for v in values)
	return degrees + minutes / 60 + seconds / 3600


def _exif_gps(photo: Photo) -> dict[str, float]:
	try:
		with _open_image(photo) as image:
			gps = image.getexif().get_ifd(GPS_IFD)
		return {
			'Latitude': _gps_degrees(gps[GPS_LATITUDE]) * (-1 if gps.get(1) == 'S' else 1),
			'Longitude': _gps_degrees(gps[GPS_LONGITUDE]) * (-1 if gps.get(3) == 'W' else 1),
		}
	except Exception:
		return {}


def _xmp_gps(photo: Photo) -> dict[str, float]:
	try:
		head = _read_head(photo)
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


def read_gps_position(photo: Photo) -> tuple[float, float] | None:
	"""The latitude/longitude ODM will use: DJI XMP over EXIF GPS, or None when unknown."""
	gps = {**_exif_gps(photo), **_xmp_gps(photo)}
	latitude, longitude = gps.get('Latitude'), gps.get('Longitude')
	if latitude is None or longitude is None or not (math.isfinite(latitude) and math.isfinite(longitude)):
		return None
	return latitude, longitude


def has_gps_position(photo: Photo) -> bool | None:
	"""True when the photo carries a GPS position, False when its metadata was read and has none.

	None means the metadata could not be read, so nothing is known. Only False is
	evidence that ODM cannot place the photo: a GPS block that exists but cannot be
	decoded counts as a position.
	"""
	if read_gps_position(photo) is not None:
		return True
	try:
		# Pillow reports a cut-off metadata block as a warning and returns what it read.
		with warnings.catch_warnings(record=True) as caught, _open_image(photo) as image:
			warnings.simplefilter('always')
			exif = image.getexif()
			gps = exif.get_ifd(GPS_IFD) if GPS_IFD in exif else {}
	except Exception:
		return None
	if any('EXIF' in str(warning.message) for warning in caught):
		return None
	if GPS_IFD not in exif:
		return False
	# A GPS block without both coordinates is how cameras record "no fix".
	return GPS_LATITUDE in gps and GPS_LONGITUDE in gps
