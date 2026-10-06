import pytest

from shared.hash import get_file_identifier


# Same vectors as frontend/src/utils/uploadFingerprint.test.ts: the upload dialog
# must compute the identical fingerprint. Sizes cover a file smaller than one
# sample, one whose two samples overlap, and one sampled at both ends only.
@pytest.mark.parametrize(
	('size', 'expected'),
	[
		(10, 'd00c9d76fe9c85740e3d08371b58fc9c92bbdee56afd46ac4a1f1bdd77f3364d'),
		(24, '2d7b7e41a02547e61eb3856acbbaecba9bd3a7ec87dd5941b6c88dd30e2d5dda'),
		(100, 'ef67568ee9adf13a1ea55a1d320a3b6766d2ff2d795e2366c8076befa58199ed'),
	],
)
def test_file_identifier_matches_the_upload_dialog(tmp_path, size, expected):
	file_path = tmp_path / 'upload.bin'
	file_path.write_bytes(bytes(index % 251 for index in range(size)))

	assert get_file_identifier(file_path, sample_size=16) == expected
