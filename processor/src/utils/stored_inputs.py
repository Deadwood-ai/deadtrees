"""Inputs of the stages that rerun from stored outputs (date estimate, georeferencing check)."""

from pathlib import Path

from shared.logger import logger
from shared.logging import LogContext
from shared.models import Cog
from shared.settings import settings

from .ssh import pull_file_from_storage_server

AOI_SOURCE_PREFERENCE = {'manual_correction': 0, 'manual': 1, 'ml_prediction': 2}


def select_aoi(aois: list[dict]) -> dict | None:
	"""The AOI to work in: an auditor's AOI before the predicted one, newest
	first; whole-image AOIs mean "no AOI"."""
	usable = [a for a in aois if a.get('geometry') and not a.get('is_whole_image')]
	if not usable:
		return None
	usable.sort(key=lambda a: a.get('created_at') or '', reverse=True)
	usable.sort(key=lambda a: AOI_SOURCE_PREFERENCE.get(a.get('source'), 3))
	return usable[0]['geometry']


def local_cog(cog: Cog, temp_dir: Path, token: str, dataset_id: int, ctx: LogContext) -> Path:
	"""The COG written by this run's cog stage, else the stored one."""
	local = temp_dir / cog.cog_file_name
	if local.exists():
		return local
	temp_dir.mkdir(parents=True, exist_ok=True)
	remote = f'{settings.STORAGE_SERVER_DATA_PATH}/{settings.COG_DIR}/{cog.cog_path}'
	logger.info(f'Pulling COG from {remote}', ctx)
	pull_file_from_storage_server(remote, str(local), token, dataset_id)
	return local
