"""Make every image loadable by ODM's photo parser. Runs *inside* the ODM image.

ODM parses the EXIF of every image before its first stage and stops the whole
run when one image raises anything other than ``PhotoCorruptedException``.
DJI cameras such as the Mavic 3M write the MakerNote as the text
"DJI MakerNotes". exifread reads that text as a tag table and walks the EXIF
bytes behind it, and in about 1% of images those bytes crash it (DT-1289).

ODM reads only the flight speed from the MakerNote, for rolling-shutter
correction, and that text holds no speed. An image that fails to parse gets its
MakerNote bytes set to zero in place and is parsed again; GPS, XMP, and pixels
stay byte-identical. An image that still fails is removed, because ODM would
stop on it.

The processor passes the source of this file to ``python3 -c`` in an ODM
container (see ``process_odm._check_photos_for_odm``); it must stay
self-contained and depend only on the standard library plus the ``opendm``
package shipped in that image.

Usage: python3 -c "<this file>" <images directory>
"""

import json
import os
import struct
import sys


def maker_note_span(data: bytes) -> tuple[int, int] | None:
	"""Return (file offset, length) of the MakerNote value in a JPEG or TIFF, or None if there is none.

	Raises ValueError when the MakerNote entry is not a byte field or points outside the EXIF data.
	"""
	if data[:2] == b'\xff\xd8':
		position = 2
		while position + 4 <= len(data) and data[position] == 0xFF and data[position + 1] != 0xDA:
			length = struct.unpack('>H', data[position + 2 : position + 4])[0]
			if data[position + 1] == 0xE1 and data[position + 4 : position + 10] == b'Exif\x00\x00':
				tiff, segment_end = position + 10, min(position + 2 + length, len(data))
				break
			position += 2 + length
		else:
			return None
	elif data[:2] in (b'II', b'MM'):
		tiff, segment_end = 0, len(data)
	else:
		return None
	endian = '<' if data[tiff : tiff + 2] == b'II' else '>'

	def number(offset: int, size: int) -> int:
		return struct.unpack(endian + ('H' if size == 2 else 'I'), data[tiff + offset : tiff + offset + size])[0]

	def find_entry(ifd: int, tag: int) -> int | None:
		for index in range(number(ifd, 2)):
			entry = ifd + 2 + 12 * index
			if number(entry, 2) == tag:
				return entry
		return None

	exif_pointer = find_entry(number(4, 4), 0x8769)
	maker_note = find_entry(number(exif_pointer + 8, 4), 0x927C) if exif_pointer is not None else None
	if maker_note is None:
		return None
	if number(maker_note + 2, 2) not in (1, 2, 7):  # BYTE, ASCII, UNDEFINED: one byte per count
		raise ValueError('MakerNote is not a byte field')
	length = number(maker_note + 4, 4)
	start = tiff + (maker_note + 8 if length <= 4 else number(maker_note + 8, 4))
	# Offsets come from the upload: only ever write inside the EXIF data that holds them.
	if start < tiff or start + length > segment_end:
		raise ValueError('MakerNote lies outside the EXIF data')
	return start, length


def blank_maker_note(path: str) -> bool:
	"""Overwrite the MakerNote value with zero bytes in place; every other byte of the file stays the same.

	exifread then reads an empty tag table (0 entries) instead of walking into the EXIF bytes behind it.
	"""
	with open(path, 'r+b') as image:
		span = maker_note_span(image.read())
		if span is None:
			return False
		start, length = span
		image.seek(start)
		image.write(bytes(length))
	return True


def parse_error(path: str) -> str | None:
	"""Return why ODM would stop on this image, or None when ODM can load or skip it."""
	from opendm.photo import ODM_Photo, PhotoCorruptedException

	try:
		ODM_Photo(path)
	except PhotoCorruptedException:
		return None  # ODM leaves corrupted images out by itself.
	except Exception as error:
		return f'{type(error).__name__}: {error}'
	return None


def check_photos(images_dir: str) -> dict:
	from opendm import context

	checked = 0
	repaired = []
	removed = []
	for name in sorted(os.listdir(images_dir)):
		path = os.path.join(images_dir, name)
		stem, ext = os.path.splitext(name)
		# Same selection as ODM's dataset stage (stages/dataset.py valid_filename).
		if not os.path.isfile(path) or ext.lower() not in context.supported_extensions or stem.endswith('_mask'):
			continue
		checked += 1
		error = parse_error(path)
		if error is None:
			continue
		try:
			if blank_maker_note(path):
				retry_error = parse_error(path)
				if retry_error is None:
					repaired.append(name)
					continue
				error = retry_error
		except Exception as repair_error:
			error = f'{error}; blanking the MakerNote failed: {type(repair_error).__name__}: {repair_error}'
		os.remove(path)
		removed.append({'image': name, 'error': error[:300]})
	return {'checked': checked, 'repaired': repaired, 'removed': removed}


if __name__ == '__main__':
	print(json.dumps(check_photos(sys.argv[1])))
