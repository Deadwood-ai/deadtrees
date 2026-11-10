"""Auditor access to the images the automated audit checks judged (audit.images).

The checks store their crops, overlays and overviews under the storage server's
``audit/`` folder. Model results and private datasets' crops stay with auditors
(docs/audit-checks.md, Access), so the files are served only on a short-lived
signed link that is issued to, and rechecked for, users with ``can_audit``.
"""

from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel

from shared.settings import settings

from ..access.core_team_files import core_team_file_response, sign_core_team_ticket
from .dataset_access import require_user

router = APIRouter()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl='token')

TICKET_RESOURCE = 'audit-images'
# audit.images.storage_path is relative to the data directory and starts with this folder
AUDIT_IMAGE_DIR = 'audit'


class AuditImageAccess(BaseModel):
	files_url: str
	expires_at: int


@router.post('/audit/images/access', response_model=AuditImageAccess)
def issue_audit_image_access(token: Annotated[str, Depends(oauth2_scheme)]):
	"""A signed link prefix for the audit images, for auditors only."""
	user = require_user(token)
	ticket, expires_at = sign_core_team_ticket(user.id, TICKET_RESOURCE, 'Audit images are limited to auditors')
	return AuditImageAccess(files_url=f'/audit/images/files/{ticket}', expires_at=expires_at)


@router.api_route('/audit/images/files/{ticket}/{relative_path:path}', methods=['GET', 'HEAD'])
def serve_audit_image(ticket: str, relative_path: str):
	"""Hand one audit image to nginx; relative_path is the storage_path below audit/. Every failure is the same 404."""
	return core_team_file_response(ticket, TICKET_RESOURCE, settings.base_path / AUDIT_IMAGE_DIR, relative_path)
