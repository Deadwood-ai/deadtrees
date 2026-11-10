"""Core-team access to a folder of files through a short-lived signed link.

The ticket only identifies the requester: every file request rechecks the
core-team (``can_audit``) privilege, and every failure is the same 404.
"""

from pathlib import Path

from fastapi import HTTPException, Response

from .dataset_files import inside
from .delivery import protected_file_response
from .privileges import user_is_core_team
from .tickets import read_ticket, sign_ticket


def sign_core_team_ticket(user_id: str, resource: str, denied_detail: str) -> tuple[str, int]:
	"""A ticket for one folder resource and its expiry, for core-team users only."""
	if not user_is_core_team(user_id):
		raise HTTPException(status_code=403, detail=denied_detail)
	return sign_ticket(user_id, resource)


def core_team_file_response(ticket: str, resource: str, root: Path, relative_path: str) -> Response:
	"""Hand one file below root to nginx for a valid ticket of a current core-team user."""
	signed = read_ticket(ticket, resource)
	if not signed or not user_is_core_team(signed.user_id):
		raise HTTPException(status_code=404, detail='Not found')
	path = inside(root, relative_path)
	if not path or not path.is_file():
		raise HTTPException(status_code=404, detail='Not found')
	return protected_file_response(path, cacheable=True)
