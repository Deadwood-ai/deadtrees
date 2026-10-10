"""The processor clears leftover temp files before every task (DT-1381)."""

import pytest

from processor.src.utils.startup_cleanup import clear_scratch

pytestmark = pytest.mark.unit


def test_clear_scratch_removes_leftover_temp_files_but_keeps_odm_output(tmp_path):
	"""A failed task can leave tens of GB in the scratch dir (13362: a 27 GB GDAL warp file);
	ODM output that DT_RETAIN_FAILED_ARTIFACTS keeps for debugging survives."""
	(tmp_path / '13362_cog_133_1.warped.tif.tmp').write_bytes(b'x' * 10)
	(tmp_path / 'treecover_13362_abc').mkdir()
	(tmp_path / 'treecover_13362_abc' / 'confidence_map.tif').write_bytes(b'x')
	(tmp_path / 'odm_temp_9654').mkdir()
	(tmp_path / 'odm_temp_9654' / 'odm_orthophoto.tif').write_bytes(b'x')

	clear_scratch(tmp_path)

	assert [entry.name for entry in tmp_path.iterdir()] == ['odm_temp_9654']
	assert (tmp_path / 'odm_temp_9654' / 'odm_orthophoto.tif').exists()
