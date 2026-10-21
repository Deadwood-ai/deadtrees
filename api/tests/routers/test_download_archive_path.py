"""Download bundles read only files inside the archive folder (DT-1429)."""

import pytest
from fastapi import HTTPException

from api.src.routers.download import archive_file_for
from shared.settings import settings


def test_archive_file_is_resolved_inside_the_archive_folder():
	path = archive_file_for({'dataset_id': 7, 'ortho_file_name': '7_ortho.tif'})

	assert path == (settings.archive_path / '7_ortho.tif').resolve()


@pytest.mark.parametrize('file_name', ['../../../proc/self/environ', '../downloads/7.zip', '/etc/passwd', ''])
def test_file_names_that_leave_the_archive_folder_are_refused(file_name):
	with pytest.raises(HTTPException) as refused:
		archive_file_for({'dataset_id': 7, 'ortho_file_name': file_name})

	assert refused.value.status_code == 404
