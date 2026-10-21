"""ODM pulls only the dataset's own uploaded zip from the storage server (DT-1429)."""

import pytest

from processor.src import process_odm
from processor.src.process_odm import require_own_raw_images_zip

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def storage_root(monkeypatch):
	monkeypatch.setattr(process_odm.settings, 'STORAGE_SERVER_DATA_PATH', '/data')


def test_the_datasets_own_upload_is_accepted():
	assert require_own_raw_images_zip('/data/raw_images/457.zip', 457) == '/data/raw_images/457.zip'


@pytest.mark.parametrize(
	'path',
	[
		'/data/raw_images/458.zip',
		'/data/raw_images/../raw_images/457.zip',
		'/data/archive/457.zip',
		'/data/raw_images/457.zip/..',
		'/other/raw_images/457.zip',
		'/data/other/raw_images/457.zip',
		'raw_images/457.zip',
		'/etc/passwd',
	],
)
def test_other_files_are_refused(path):
	with pytest.raises(ValueError):
		require_own_raw_images_zip(path, 457)
