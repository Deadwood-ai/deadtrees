"""Core-team access to the internal forest disturbance benchmark viewer.

The benchmark export (site catalogue, site JSON, drone, satellite and context
imagery) is a static folder on the storage server. It contains third-party
imagery that may not be redistributed, so its files are served only on a
short-lived signed link that is issued to, and rechecked for, core-team users.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel

from shared.db import use_service_client, verify_token
from shared.settings import settings

from ..access.dataset_files import inside
from ..access.delivery import protected_file_response
from ..access.tickets import read_ticket, sign_ticket

router = APIRouter()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl='token')

TICKET_RESOURCE = 'disturbance-benchmark'


def user_is_core_team(user_id: str) -> bool:
	with use_service_client() as client:
		rows = (
			client.table('privileged_users')
			.select('user_id')
			.eq('user_id', user_id)
			.eq('can_audit', True)
			.limit(1)
			.execute()
			.data
		)
	return bool(rows)


class BenchmarkAccess(BaseModel):
	files_url: str
	expires_at: int


@router.post('/disturbance-benchmark/access', response_model=BenchmarkAccess)
def issue_benchmark_access(token: Annotated[str, Depends(oauth2_scheme)]):
	"""A signed link prefix for the benchmark files, for core-team users only."""
	user = verify_token(token) if token else None
	if not user:
		raise HTTPException(status_code=401, detail='Sign in to continue')
	if not user_is_core_team(user.id):
		raise HTTPException(status_code=403, detail='The benchmark is limited to the core team')
	ticket, expires_at = sign_ticket(user.id, TICKET_RESOURCE)
	return BenchmarkAccess(files_url=f'/disturbance-benchmark/files/{ticket}', expires_at=expires_at)


@router.api_route('/disturbance-benchmark/files/{ticket}/{relative_path:path}', methods=['GET', 'HEAD'])
def serve_benchmark_file(ticket: str, relative_path: str):
	"""Hand one benchmark file to nginx. Every failure is the same 404."""
	signed = read_ticket(ticket, TICKET_RESOURCE)
	if not signed or not user_is_core_team(signed.user_id):
		raise HTTPException(status_code=404, detail='Not found')
	path = inside(settings.base_path / settings.DISTURBANCE_BENCHMARK_DIR, relative_path)
	if not path or not path.is_file():
		raise HTTPException(status_code=404, detail='Not found')
	return protected_file_response(path, cacheable=True)
