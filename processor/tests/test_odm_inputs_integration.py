"""Real ODM runs on upload shapes that used to fail (DT-1312).

Both variants are built from the minimal 5-image DJI set: one adds a same-name DNG next to
every JPG, the other adds a frame whose GPS is a failed 0/0 fix. ODM must still produce an
orthomosaic, which needs the processor to leave those files out.
"""

import zipfile
from pathlib import Path

import pytest
from PIL import Image

from shared.db import use_client
from shared.settings import settings
from processor.src.process_odm import process_odm
from processor.src.utils.ssh import check_file_exists_on_storage
from processor.tests.test_process_odm import odm_task, odm_test_dataset  # noqa: F401 (fixtures)


def _minimal_zip() -> Path:
	for candidate in (
		Path(settings.base_path) / 'assets' / 'test_data' / 'raw_drone_images' / 'test_minimal_5_images.zip',
		Path('/app/assets/test_data/raw_drone_images/test_minimal_5_images.zip'),
	):
		if candidate.exists():
			return candidate
	pytest.skip('test_minimal_5_images.zip not found; run `make download-assets`')


def _with_paired_dngs(source: Path, target: Path) -> None:
	with zipfile.ZipFile(source) as src, zipfile.ZipFile(target, 'w') as out:
		for name in src.namelist():
			data = src.read(name)
			out.writestr(name, data)
			if name.upper().endswith('.JPG'):
				# Not a decodable raw: if it reached ODM, LibRaw would fail like DT-913.
				out.writestr(name[:-4] + '.DNG', data)


def _with_zero_gps_frame(source: Path, target: Path, workdir: Path) -> None:
	with zipfile.ZipFile(source) as src:
		src.extractall(workdir)
	first_jpg = sorted(workdir.rglob('*.JPG'))[0]
	image = Image.open(first_jpg)
	exif = image.getexif()
	gps = exif.get_ifd(0x8825)
	gps[2] = gps[4] = (0.0, 0.0, 0.0)
	broken = workdir / 'DJI_GPS_ZERO_D.JPG'
	image.save(broken, exif=exif, quality=95)
	with zipfile.ZipFile(source) as src, zipfile.ZipFile(target, 'w') as out:
		for name in src.namelist():
			out.writestr(name, src.read(name))
		out.write(broken, broken.name)


@pytest.fixture(params=['paired_dng', 'zero_gps_frame'])
def test_zip_file(request, tmp_path):
	target = tmp_path / f'{request.param}.zip'
	if request.param == 'paired_dng':
		_with_paired_dngs(_minimal_zip(), target)
	else:
		_with_zero_gps_frame(_minimal_zip(), target, tmp_path / 'frames')
	return target


@pytest.mark.slow
def test_odm_makes_an_orthomosaic_despite_input_noise(odm_task, auth_token):  # noqa: F811
	process_odm(odm_task, Path(settings.processing_path))

	with use_client(auth_token) as client:
		status = client.table(settings.statuses_table).select('*').eq('dataset_id', odm_task.dataset_id).execute()
	assert status.data[0]['is_odm_done'] is True
	assert status.data[0]['has_error'] is False
	assert check_file_exists_on_storage(f'{settings.archive_path}/{odm_task.dataset_id}_ortho.tif', auth_token)
