from pathlib import Path

from shared.logger import logger
from shared.logging import LogContext
from shared.settings import settings

from .ssh import pull_file_from_storage_server


def ensure_local_ortho(
	local_path: Path,
	ortho_file_name: str,
	token: str,
	dataset_id: int,
	log_context: LogContext,
) -> Path:
	"""Prefer a standardized local ortho from the shared processing dir.

	GeoTIFF standardization writes the converted ortho to the pipeline temp dir and
	keeps it local for downstream stages. If that file is missing (for example when
	a single stage is rerun independently), fall back to pulling the archive ortho.
	"""
	if local_path.exists():
		logger.info(
			f'Using local standardized ortho at {local_path}',
			log_context,
		)
		return local_path

	storage_server_file_path = f'{settings.STORAGE_SERVER_DATA_PATH}/archive/{ortho_file_name}'
	logger.info(
		f'Local standardized ortho missing, pulling archive ortho from {storage_server_file_path}',
		log_context,
	)
	pull_file_from_storage_server(storage_server_file_path, str(local_path), token, dataset_id)
	return local_path
