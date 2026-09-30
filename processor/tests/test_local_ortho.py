import pytest

from shared.logging import LogContext, LogCategory
from processor.src.exceptions import DatasetError
from processor.src.utils.local_ortho import ensure_local_ortho

pytestmark = pytest.mark.unit


def test_ensure_local_ortho_uses_existing_local_file(tmp_path):
	local_path = tmp_path / '123_ortho.tif'
	local_path.write_text('already standardized')
	result = ensure_local_ortho(
		local_path=local_path,
		ortho_file_name='123_ortho.tif',
		token='token',
		dataset_id=123,
		log_context=LogContext(category=LogCategory.ORTHO, dataset_id=123, token='token'),
	)

	assert result == local_path


def test_ensure_local_ortho_rejects_missing_standardized_file(tmp_path):
	"""The raw archive ortho must never substitute for the standardized file."""
	with pytest.raises(DatasetError, match='rerun downstream stages together with the geotiff stage'):
		ensure_local_ortho(
			local_path=tmp_path / '456_ortho.tif',
			ortho_file_name='456_ortho.tif',
			token='token',
			dataset_id=456,
			log_context=LogContext(category=LogCategory.ORTHO, dataset_id=456, token='token'),
		)
