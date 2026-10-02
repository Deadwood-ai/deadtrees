"""Dataset file delivery and visibility changes.

Image files keep one storage location whatever the dataset's visibility. Public and
view-only files are served by nginx after a cached authorization subrequest; private
files and every prepared export are served on short-lived signed links that are
checked against the user's current access on each request.
"""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, Field

from shared.db import use_client, use_service_client, verify_token
from shared.models import DatasetAccessEnum
from shared.settings import settings

from ..access.dataset_access import user_can_view_dataset
from ..access.dataset_files import FILE_COLUMNS, find_dataset_file, inside, stored_file_path
from ..access.delivery import protected_file_response
from ..access.tickets import read_ticket, sign_ticket
from ..access.visibility import change_dataset_visibility
from ..download.delivery import require_export_access
from ..download.jobs import PreparedFileJob

router = APIRouter()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl='token')

FileKind = Literal['cog', 'thumbnail']


def require_user(token: str):
	user = verify_token(token) if token else None
	if not user:
		raise HTTPException(status_code=401, detail='Sign in to continue')
	return user


class FileTicketRequest(BaseModel):
	dataset_ids: list[int] = Field(min_length=1, max_length=200)


class PrivateDatasetFiles(BaseModel):
	cog_url: str | None = None
	thumbnail_url: str | None = None
	expires_at: int


class FileTicketResponse(BaseModel):
	files: dict[int, PrivateDatasetFiles]


@router.post('/datasets/files/tickets', response_model=FileTicketResponse)
def issue_private_file_tickets(
	payload: FileTicketRequest,
	token: Annotated[str, Depends(oauth2_scheme)],
):
	"""Signed links for the COG and thumbnail of private datasets the caller can view.

	Public and view-only datasets keep their static URLs and are absent here, as are
	datasets the caller cannot view.
	"""
	user = require_user(token)
	dataset_ids = sorted(set(payload.dataset_ids))
	files: dict[int, PrivateDatasetFiles] = {}
	with use_client(token) as client:
		visible = client.table(settings.datasets_table).select('id,data_access').in_('id', dataset_ids).execute().data
		private_ids = [row['id'] for row in visible if row['data_access'] == DatasetAccessEnum.private.value]
		if not private_ids:
			return FileTicketResponse(files=files)
		for kind, (table, column) in FILE_COLUMNS.items():
			rows = client.table(table).select(f'dataset_id,{column}').in_('dataset_id', private_ids).execute().data
			for row in rows:
				if not row.get(column):
					continue
				dataset_id = row['dataset_id']
				ticket, expires_at = sign_ticket(user.id, f'{kind}:{dataset_id}')
				entry = files.setdefault(dataset_id, PrivateDatasetFiles(expires_at=expires_at))
				setattr(entry, f'{kind}_url', f'/datasets/{dataset_id}/files/{kind}/{ticket}')
	return FileTicketResponse(files=files)


@router.api_route('/datasets/{dataset_id}/files/{kind}/{ticket}', methods=['GET', 'HEAD'])
def serve_private_dataset_file(dataset_id: int, kind: FileKind, ticket: str):
	"""Hand a private COG or thumbnail to nginx, which also serves range requests.

	Every failure is the same 404 so a request reveals nothing about a dataset.
	"""
	signed = read_ticket(ticket, f'{kind}:{dataset_id}')
	if not signed or not user_can_view_dataset(dataset_id, signed.user_id):
		raise HTTPException(status_code=404, detail='Not found')
	with use_service_client() as client:
		relative_path = stored_file_path(client, kind, dataset_id)
	path = find_dataset_file(kind, relative_path) if relative_path else None
	if not path:
		raise HTTPException(status_code=404, detail='Not found')
	return protected_file_response(path)


STATIC_FILE_PREFIXES = {'cogs': 'cog', 'thumbnails': 'thumbnail'}


@router.get('/public-files/authorize/{prefix}/v1/{relative_path:path}')
def authorize_public_dataset_file(prefix: Literal['cogs', 'thumbnails'], relative_path: str):
	"""nginx auth_request for a static /cogs/v1 or /thumbnails/v1 URL (passed as the original request URI).

	Only the current file of a public or view-only dataset is allowed. Old file
	versions and files of private datasets are refused, so making a dataset private
	closes its static URLs once nginx's short authorization cache expires. A URI that
	does not name a stored path exactly is refused.
	"""
	kind = STATIC_FILE_PREFIXES[prefix]
	with use_service_client() as client:
		allowed = client.rpc('is_public_dataset_file', {'p_kind': kind, 'p_path': relative_path}).execute().data
	return Response(status_code=204 if allowed else 403)


@router.api_route('/exports/{ticket}/{relative_path:path}', methods=['GET', 'HEAD'])
def serve_export(ticket: str, relative_path: str):
	"""Hand a prepared download to nginx once the user may download everything in it."""
	signed = read_ticket(ticket, f'export:{relative_path}')
	path = inside(settings.downloads_path, relative_path)
	if not signed or not path:
		raise HTTPException(status_code=404, detail='Not found')
	require_export_access(PreparedFileJob(path), signed.user_id)
	return protected_file_response(path, attachment=True)


class VisibilityRequest(BaseModel):
	data_access: DatasetAccessEnum


class VisibilityResponse(BaseModel):
	dataset_id: int
	data_access: DatasetAccessEnum
	previous_data_access: DatasetAccessEnum


@router.put('/datasets/{dataset_id}/visibility', response_model=VisibilityResponse)
def update_dataset_visibility(
	dataset_id: int,
	payload: VisibilityRequest,
	token: Annotated[str, Depends(oauth2_scheme)],
):
	"""Change visibility and record it in one transaction; files never move."""
	require_user(token)
	previous = change_dataset_visibility(dataset_id, token, payload.data_access)
	return VisibilityResponse(dataset_id=dataset_id, data_access=payload.data_access, previous_data_access=previous)
