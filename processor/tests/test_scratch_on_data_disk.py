"""Processor scratch stays on the /data disk instead of the hosts' root disk."""

import io
import os
import tarfile
import tempfile
import time

import pytest

import processor.src.continuous_processor as continuous_processor
from processor.src.utils import shared_volume, startup_cleanup


@pytest.fixture
def base_dir(monkeypatch, tmp_path):
	monkeypatch.setattr(continuous_processor.settings, 'BASE_DIR', str(tmp_path))
	monkeypatch.setattr(tempfile, 'tempdir', tempfile.tempdir)
	for name in ('TMPDIR', 'CPL_TMPDIR'):
		monkeypatch.setenv(name, os.environ.get(name, ''))
	return tmp_path


@pytest.mark.unit
def test_temp_files_go_to_the_scratch_dir_on_base_dir(base_dir):
	continuous_processor.use_data_disk_for_temp_files()

	scratch = base_dir / 'processor_tmp'
	assert os.environ['TMPDIR'] == os.environ['CPL_TMPDIR'] == str(scratch)
	with tempfile.NamedTemporaryFile() as handle:
		assert os.path.dirname(handle.name) == str(scratch)


@pytest.mark.unit
def test_startup_cleanup_removes_old_scratch_files_and_dirs(base_dir, monkeypatch):
	scratch = base_dir / 'processor_tmp'
	scratch.mkdir()
	old_file, old_dir, fresh = scratch / 'tmpabc_aoi_mask.tif', scratch / 'treecover_1_x', scratch / 'tmpnew'
	old_file.write_text('x')
	old_dir.mkdir()
	fresh.write_text('x')
	day_ago = time.time() - 25 * 3600
	for path in (old_file, old_dir):
		os.utime(path, (day_ago, day_ago))
	monkeypatch.setattr(startup_cleanup.logger, 'info', lambda *args, **kwargs: None)

	startup_cleanup.cleanup_old_temp_directories('token')

	assert sorted(p.name for p in scratch.iterdir()) == ['tmpnew']


@pytest.mark.unit
def test_odm_results_copy_only_the_orthophoto(tmp_path, monkeypatch):
	requested = []
	buffer = io.BytesIO()
	with tarfile.open(fileobj=buffer, mode='w') as tar:
		data = b'tif'
		info = tarfile.TarInfo('odm_orthophoto/odm_orthophoto.tif')
		info.size = len(data)
		tar.addfile(info, io.BytesIO(data))

	class _Container:
		short_id = 'c1'

		def start(self):
			pass

		def exec_run(self, command):
			return type('Result', (), {'exit_code': 0})()

		def get_archive(self, path):
			requested.append(path)
			return iter([buffer.getvalue()]), {}

		def remove(self, force):
			pass

	client = type('Client', (), {'containers': type('C', (), {'create': lambda self, **kwargs: _Container()})()})()
	monkeypatch.setattr(shared_volume, '_docker_client', lambda: client)
	monkeypatch.setattr(shared_volume.logger, 'info', lambda *args, **kwargs: None)

	shared_volume.copy_results_from_shared_volume('vol', tmp_path, 'dataset_7', 7, 'token')

	assert requested == ['/odm_shared/dataset_7/odm_orthophoto']
	assert (tmp_path / 'dataset_7' / 'odm_orthophoto' / 'odm_orthophoto.tif').read_bytes() == b'tif'
