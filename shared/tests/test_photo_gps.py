"""GPS reading shared by the upload rules and the processor (DT-1582).

The fixtures and their expected answers are shared with the browser mirror
(frontend/src/utils/photoGps.test.ts), so both readers agree on every case.
"""

import json
from pathlib import Path

import pytest

from shared.photo_gps import has_gps_position, read_gps_position

_FIXTURES = Path(__file__).parents[2] / 'frontend' / 'test' / 'fixtures' / 'photo-gps'
_CASES = json.loads((_FIXTURES / 'manifest.json').read_text())['cases'] if _FIXTURES.exists() else []

pytestmark = [
	pytest.mark.unit,
	pytest.mark.skipif(not _FIXTURES.exists(), reason='frontend fixtures are not in this image'),
	pytest.mark.filterwarnings('ignore::UserWarning'),
]


@pytest.mark.parametrize('case', _CASES, ids=[case['file'] for case in _CASES])
def test_has_gps_position_matches_the_shared_fixture(case):
	assert has_gps_position(_FIXTURES / case['file']) is case['has_gps']


@pytest.mark.parametrize('case', _CASES, ids=[case['file'] for case in _CASES])
def test_open_files_read_like_paths(case):
	with open(_FIXTURES / case['file'], 'rb') as photo:
		assert has_gps_position(photo) is case['has_gps']


def test_positions_keep_their_hemisphere():
	assert read_gps_position(_FIXTURES / 'gps-big-endian.tif') == pytest.approx((-33.5, -70.25), abs=1e-6)
	assert read_gps_position(_FIXTURES / 'dji-xmp-only.jpg') == pytest.approx((48.0, 7.85))
