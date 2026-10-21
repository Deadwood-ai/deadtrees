"""ODM pulls only the dataset's own uploaded zip from the storage server (DT-1429)."""

import pytest

from processor.src.process_odm import require_own_raw_images_zip


def test_the_datasets_own_upload_is_accepted():
	require_own_raw_images_zip('/data/raw_images/457.zip', 457)


@pytest.mark.parametrize(
	'path',
	[
		'/data/raw_images/458.zip',
		'/data/raw_images/../raw_images/457.zip',
		'/data/archive/457.zip',
		'/data/raw_images/457.zip/..',
		'/etc/passwd',
	],
)
def test_other_files_are_refused(path):
	with pytest.raises(ValueError):
		require_own_raw_images_zip(path, 457)
