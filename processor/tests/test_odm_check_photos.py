import io
import json
import struct
import sys
import tarfile
import types

import pytest

from processor.src.utils import odm_check_photos


class _PhotoCorrupted(Exception):
	pass


@pytest.fixture
def fake_odm(monkeypatch):
	"""Stand-in for the opendm package in the ODM image: parse outcome per file content."""

	def odm_photo(path):
		content = open(path, 'rb').read()
		if content.startswith(b'corrupt'):
			raise _PhotoCorrupted(path)
		if b'makernote' in content or content.startswith(b'broken'):
			raise IndexError('list index out of range')

	photo_module = types.ModuleType('opendm.photo')
	photo_module.ODM_Photo = odm_photo
	photo_module.PhotoCorruptedException = _PhotoCorrupted
	context_module = types.ModuleType('opendm.context')
	context_module.supported_extensions = {'.jpg', '.jpeg', '.tif'}
	opendm = types.ModuleType('opendm')
	opendm.context = context_module
	monkeypatch.setitem(sys.modules, 'opendm', opendm)
	monkeypatch.setitem(sys.modules, 'opendm.photo', photo_module)
	monkeypatch.setitem(sys.modules, 'opendm.context', context_module)

	def blank_maker_note(path):
		content = open(path, 'rb').read()
		if b'makernote' not in content:
			return False
		open(path, 'wb').write(content.replace(b'makernote', b''))
		return True

	monkeypatch.setattr(odm_check_photos, 'blank_maker_note', blank_maker_note)


@pytest.mark.unit
def test_check_photos_repairs_or_removes_only_images_odm_cannot_parse(tmp_path, fake_odm):
	files = {
		'ok.JPG': b'fine',
		'dji_placeholder.JPG': b'fine makernote',
		'broken.jpg': b'broken',
		'corrupt.jpg': b'corrupt',  # ODM skips PhotoCorruptedException itself
		'broken_mask.jpg': b'broken',  # masks are not photos in ODM's dataset stage
		'notes.MRK': b'broken',
	}
	for name, content in files.items():
		(tmp_path / name).write_bytes(content)

	summary = odm_check_photos.check_photos(str(tmp_path))

	assert summary['checked'] == 4
	assert summary['repaired'] == ['dji_placeholder.JPG']
	assert [entry['image'] for entry in summary['removed']] == ['broken.jpg']
	assert 'IndexError' in summary['removed'][0]['error']
	assert sorted(path.name for path in tmp_path.iterdir()) == sorted(set(files) - {'broken.jpg'})
	assert (tmp_path / 'ok.JPG').read_bytes() == b'fine'
	assert (tmp_path / 'dji_placeholder.JPG').read_bytes() == b'fine '


@pytest.mark.unit
def test_check_photos_removes_image_when_makernote_removal_fails(tmp_path, fake_odm, monkeypatch):
	(tmp_path / 'a.jpg').write_bytes(b'makernote')

	def failing_removal(path):
		raise ValueError('bad exif')

	monkeypatch.setattr(odm_check_photos, 'blank_maker_note', failing_removal)

	summary = odm_check_photos.check_photos(str(tmp_path))

	assert summary['repaired'] == []
	assert summary['removed'][0]['image'] == 'a.jpg'
	assert 'blanking the MakerNote failed: ValueError: bad exif' in summary['removed'][0]['error']
	assert not (tmp_path / 'a.jpg').exists()


@pytest.mark.unit
def test_blank_maker_note_zeroes_only_the_maker_note_bytes(tmp_path):
	path = tmp_path / 'DJI_0001_D.JPG'
	original = _dji_photo_that_crashes_exifread()
	path.write_bytes(original)
	start, length = odm_check_photos.maker_note_span(original)

	assert odm_check_photos.blank_maker_note(str(path)) is True

	blanked = path.read_bytes()
	assert original[start : start + length].startswith(struct.pack('<H', 1))
	assert blanked[start : start + length] == bytes(length)
	assert blanked[:start] == original[:start] and blanked[start + length :] == original[start + length :]


@pytest.mark.unit
@pytest.mark.parametrize('bad_field', ['offset', 'count'])
def test_blank_maker_note_refuses_to_write_outside_the_exif_data(tmp_path, bad_field):
	original = _dji_photo_that_crashes_exifread()
	start, length = odm_check_photos.maker_note_span(original)
	data = bytearray(original)
	# The MakerNote entry holds (tag, type, count, offset); rewrite the count or offset field.
	tiff = original.index(b'Exif\x00\x00') + 6
	endian = '<' if original[tiff : tiff + 2] == b'II' else '>'
	entry = original.index(struct.pack(f'{endian}H', 0x927C), tiff + 8)
	field = entry + (4 if bad_field == 'count' else 8)
	data[field : field + 4] = struct.pack(f'{endian}I', 0x7FFFFFF0)
	path = tmp_path / 'malformed.jpg'
	path.write_bytes(bytes(data))

	with pytest.raises(ValueError, match='outside the EXIF data'):
		odm_check_photos.blank_maker_note(str(path))
	assert path.read_bytes() == bytes(data)


@pytest.mark.unit
def test_blank_maker_note_leaves_images_without_maker_note_alone(tmp_path):
	from PIL import Image

	path = tmp_path / 'plain.jpg'
	Image.new('RGB', (8, 8)).save(path, 'JPEG')
	original = path.read_bytes()

	assert odm_check_photos.blank_maker_note(str(path)) is False
	assert path.read_bytes() == original


@pytest.mark.unit
def test_script_source_is_self_contained():
	"""The processor ships this file's source to python -c in the ODM image: no processor imports."""
	source = open(odm_check_photos.__file__).read()
	assert 'from processor' not in source and 'import processor' not in source
	assert 'from shared' not in source


def _dji_photo_that_crashes_exifread() -> bytes:
	"""A JPEG with GPS whose DJI MakerNote holds an entry exifread 3.5 cannot print (DT-1289).

	Real Mavic 3M photos store the text "DJI MakerNotes", which exifread walks as a
	tag table; a DOUBLE entry that points past the file end yields the same IndexError.
	"""
	from PIL import Image

	maker_note = struct.pack('<H', 1) + struct.pack('<HHII', 0x0003, 12, 1, 0x7FFFFFF0) + struct.pack('<I', 0)
	exif = Image.Exif()
	exif[0x010F] = 'DJI'
	exif[0x0110] = 'M3M'
	exif_ifd = exif.get_ifd(0x8769)
	exif_ifd[0x927C] = maker_note
	exif_ifd[0x920A] = 12.29
	gps = exif.get_ifd(0x8825)
	gps.update({1: 'N', 2: (48.0, 36.0, 41.93), 3: 'E', 4: (8.0, 21.0, 15.89), 5: 0, 6: 767.9})
	buffer = io.BytesIO()
	Image.new('RGB', (64, 64), (40, 120, 40)).save(buffer, 'JPEG', exif=exif)
	return buffer.getvalue()


_PARSE_IN_ODM = """
import json, sys
from opendm.photo import ODM_Photo
try:
	photo = ODM_Photo(sys.argv[1])
	print(json.dumps({'latitude': photo.latitude, 'longitude': photo.longitude, 'altitude': photo.altitude}))
except Exception as error:
	print(json.dumps({'error': type(error).__name__}))
"""


def test_odm_image_parses_dji_placeholder_photo_after_check():
	"""In the pinned ODM image, the raw photo crashes ODM's parser and the checked photo keeps its GPS.

	Needs Docker and the ODM image, but no Supabase or storage, so it carries no slow or
	integration marker (those trigger storage cleanup). Rerun it when ODM_IMAGE changes.
	"""
	docker = pytest.importorskip('docker')
	from shared.settings import settings

	try:
		client = docker.from_env()
		client.images.get(settings.ODM_IMAGE)
	except docker.errors.DockerException as error:
		pytest.skip(f'Docker or {settings.ODM_IMAGE} is not available: {error}')

	archive = io.BytesIO()
	with tarfile.open(fileobj=archive, mode='w') as tar:
		for name, content in {
			'images/DJI_0001_D.JPG': _dji_photo_that_crashes_exifread(),
			'raw/DJI_0001_D.JPG': _dji_photo_that_crashes_exifread(),
			'check.py': open(odm_check_photos.__file__, 'rb').read(),
			'parse.py': _PARSE_IN_ODM.encode(),
		}.items():
			info = tarfile.TarInfo(name)
			info.size = len(content)
			tar.addfile(info, io.BytesIO(content))

	command = (
		'python3 /w/check.py /w/images && python3 /w/parse.py /w/raw/DJI_0001_D.JPG '
		'&& python3 /w/parse.py /w/images/DJI_0001_D.JPG'
	)
	container = client.containers.create(
		settings.ODM_IMAGE, entrypoint='sh', command=['-c', 'sleep 600'], network_disabled=True
	)
	try:
		container.start()
		container.exec_run('mkdir -p /w')
		container.put_archive('/w', archive.getvalue())
		exit_code, output = container.exec_run(['sh', '-c', command], workdir='/code')
	finally:
		container.remove(force=True)

	lines = [line for line in output.decode().splitlines() if line.startswith('{')]
	assert exit_code == 0, output.decode()[-2000:]
	summary, raw, checked = (json.loads(line) for line in lines[-3:])
	assert summary == {'checked': 1, 'repaired': ['DJI_0001_D.JPG'], 'removed': []}
	assert raw == {'error': 'IndexError'}
	assert checked['latitude'] == pytest.approx(48.61165, abs=1e-5)
	assert checked['longitude'] == pytest.approx(8.35441, abs=1e-5)
	assert checked['altitude'] == pytest.approx(767.9)


@pytest.mark.unit
def test_hung_odm_container_is_stopped_with_a_clear_error(monkeypatch):
	import requests

	from processor.src import process_odm as odm_module

	events = []

	class _Container:
		def wait(self, timeout):
			events.append(('wait', timeout))
			clock[0] += timeout
			raise requests.exceptions.ReadTimeout('read timed out')

		def logs(self, tail):
			return b'texturing tile 3/9'

		def kill(self):
			events.append(('kill',))

	clock = [1000.0]
	monkeypatch.setattr(odm_module.time, 'monotonic', lambda: clock[0])
	monkeypatch.setattr(odm_module.settings, 'ODM_RUN_TIMEOUT_SECONDS', 7200)

	with pytest.raises(TimeoutError, match='(?s)ODM full pass did not finish within 2 h.*texturing tile 3/9'):
		odm_module._wait_for_container(_Container(), 'ODM full pass')

	assert events == [('wait', 7200), ('kill',)]


@pytest.mark.unit
def test_docker_socket_error_before_the_deadline_is_not_reported_as_a_timeout(monkeypatch):
	import requests

	from processor.src import process_odm as odm_module

	class _Container:
		def wait(self, timeout):
			raise requests.exceptions.ConnectionError('socket closed')

		def kill(self):
			raise AssertionError('a healthy run must not be killed')

	with pytest.raises(requests.exceptions.ConnectionError, match='socket closed'):
		odm_module._wait_for_container(_Container(), 'ODM full pass')
