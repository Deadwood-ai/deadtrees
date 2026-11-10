"""Core-team access to the internal forest disturbance benchmark viewer.

The benchmark export (site catalogue, site JSON, drone, satellite and context
imagery) is a static folder on the storage server. It contains third-party
imagery that may not be redistributed, so its files are served only on a
short-lived signed link that is issued to, and rechecked for, core-team users.
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

TICKET_RESOURCE = 'disturbance-benchmark'


class BenchmarkAccess(BaseModel):
	files_url: str
	expires_at: int


@router.post('/disturbance-benchmark/access', response_model=BenchmarkAccess)
def issue_benchmark_access(token: Annotated[str, Depends(oauth2_scheme)]):
	"""A signed link prefix for the benchmark files, for core-team users only."""
	user = require_user(token)
	ticket, expires_at = sign_core_team_ticket(user.id, TICKET_RESOURCE, 'The benchmark is limited to the core team')
	return BenchmarkAccess(files_url=f'/disturbance-benchmark/files/{ticket}', expires_at=expires_at)


@router.api_route('/disturbance-benchmark/files/{ticket}/{relative_path:path}', methods=['GET', 'HEAD'])
def serve_benchmark_file(ticket: str, relative_path: str):
	"""Hand one benchmark file to nginx. Every failure is the same 404."""
	return core_team_file_response(
		ticket, TICKET_RESOURCE, settings.base_path / settings.DISTURBANCE_BENCHMARK_DIR, relative_path
	)
