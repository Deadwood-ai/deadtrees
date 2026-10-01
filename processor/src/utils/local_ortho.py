from pathlib import Path

from shared.logger import logger
from shared.logging import LogContext

from ..exceptions import DatasetError


def ensure_local_ortho(
	local_path: Path,
	ortho_file_name: str,
	token: str,
	dataset_id: int,
	log_context: LogContext,
) -> Path:
	"""Return the standardized local ortho written by this run's GeoTIFF stage.

	Standardization keeps the converted ortho local and never pushes it to storage,
	so downstream stages must run after ``geotiff`` in the same run. The archive
	ortho is the raw upload and is never used as a substitute.
	"""
	if not local_path.exists():
		raise DatasetError(
			f'Standardized ortho {ortho_file_name} is missing at {local_path}; '
			'rerun downstream stages together with the geotiff stage',
			dataset_id=dataset_id,
		)
	logger.info(f'Using local standardized ortho at {local_path}', log_context)
	return local_path
