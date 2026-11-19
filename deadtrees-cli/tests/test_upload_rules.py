"""The CLI applies the API's upload rules locally, before signing in or sending any bytes (DT-1582)."""

from pathlib import Path

import pytest

from deadtrees_cli.data import DataCommands
from shared.upload_validation import UnprocessableUploadError

_PHOTO_FIXTURES = Path(__file__).parents[2] / 'frontend' / 'test' / 'fixtures' / 'photo-gps'

pytestmark = pytest.mark.skipif(not _PHOTO_FIXTURES.exists(), reason='frontend fixtures are not in this image')


def test_upload_of_photos_without_gps_fails_before_sign_in(monkeypatch):
	commands = DataCommands()
	monkeypatch.setattr(commands, '_ensure_auth', lambda: pytest.fail('signed in for an unprocessable upload'))
	monkeypatch.setattr(commands, '_chunked_upload', lambda **_kwargs: pytest.fail('sent an unprocessable upload'))

	with pytest.raises(UnprocessableUploadError, match='None of the checked photos'):
		commands.upload(file_path=str(_PHOTO_FIXTURES / 'no-gps-flight.zip'), authors=['Test Author'])
