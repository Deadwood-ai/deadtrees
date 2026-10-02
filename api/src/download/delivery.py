"""Deliver prepared download files only to users who may download everything in them.

A finished file's manifest (see jobs.py) lists its export kind and datasets. The API
returns a short-lived signed link instead of a static path; every request on that
link re-checks the user's current download permission for each listed dataset, so a
guessed, forwarded or stale link stops working once access ends.
"""

from fastapi import HTTPException

from shared.settings import settings
from ..access.dataset_access import user_can_download_datasets
from ..access.tickets import sign_ticket
from .jobs import PreparedFileJob


def require_export_access(job: PreparedFileJob, user_id: str) -> None:
	manifest = job.manifest()
	if manifest is None or not user_can_download_datasets(manifest.dataset_ids, manifest.kind, user_id):
		raise HTTPException(status_code=404, detail='Not found')


def export_url(job: PreparedFileJob, user_id: str) -> str:
	"""A signed link to the finished file, bound to the user and the file."""
	require_export_access(job, user_id)
	relative = job.path.relative_to(settings.downloads_path).as_posix()
	ticket, _ = sign_ticket(user_id, f'export:{relative}')
	return f'{settings.UVICORN_ROOT_PATH}/exports/{ticket}/{relative}'
