from datetime import date
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, Field

from shared.db import use_client, use_service_client, verify_token

from ..priwa.warnkarte import ValidatedWarnkarte, WarnkarteValidationError, validate_warnkarte_file


router = APIRouter(prefix='/priwa/warnkarte', tags=['priwa-warnkarte'])
oauth2_scheme = OAuth2PasswordBearer(tokenUrl='token')


class WarnkarteValidationSummary(BaseModel):
	source_filename: str
	checksum_sha256: str
	authoritative_date: date
	layer: str
	crs: str
	feature_count: int
	warnings: list[dict[str, Any]] = Field(default_factory=list)


class WarnkarteImportResponse(BaseModel):
	version_id: str
	summary: WarnkarteValidationSummary


class WarnkarteVersion(BaseModel):
	id: str
	source_date: date
	source_filename: str
	checksum_sha256: str
	source_layer: str
	source_crs: str
	feature_count: int
	imported_by: str
	imported_at: str
	is_current: bool


class WarnkartePublicationResponse(BaseModel):
	publication_id: int
	version_id: str


def validation_http_error(error: WarnkarteValidationError) -> HTTPException:
	return HTTPException(status_code=error.status_code, detail=error.as_detail())


def require_user(token: str):
	user = verify_token(token)
	if not user:
		raise HTTPException(
			status_code=status.HTTP_401_UNAUTHORIZED,
			detail={
				'code': 'INVALID_TOKEN',
				'message': 'Die Anmeldung ist ungültig oder abgelaufen.',
				'details': {},
			},
		)
	return user


def require_project_access(token: str, project_id: str, *, admin: bool) -> None:
	rpc_name = 'priwa_is_project_admin' if admin else 'priwa_is_project_member'
	with use_client(token) as client:
		allowed = bool(client.rpc(rpc_name, {'p_project_id': project_id}).execute().data)
	if not allowed:
		code = 'ADMIN_REQUIRED' if admin else 'MEMBERSHIP_REQUIRED'
		message = (
			'Für diese Warnkarten-Verwaltung ist eine PRIWA-Adminrolle erforderlich.'
			if admin
			else 'Für diese Warnkarte ist eine PRIWA-Projektmitgliedschaft erforderlich.'
		)
		raise HTTPException(
			status_code=status.HTTP_403_FORBIDDEN,
			detail={'code': code, 'message': message, 'details': {'project_id': project_id}},
		)


def validate_upload(file: UploadFile) -> ValidatedWarnkarte:
	try:
		return validate_warnkarte_file(file.file, file.filename)
	except WarnkarteValidationError as error:
		raise validation_http_error(error) from error


def ensure_unique_checksum(token: str, project_id: str, validated: ValidatedWarnkarte) -> None:
	with use_client(token) as client:
		response = (
			client.table('priwa_warnkarte_versions')
			.select('id')
			.eq('project_id', project_id)
			.eq('checksum_sha256', validated.checksum_sha256)
			.limit(1)
			.execute()
		)
	if response.data:
		raise HTTPException(
			status_code=status.HTTP_409_CONFLICT,
			detail={
				'code': 'DUPLICATE_CHECKSUM',
				'message': 'Dieses GeoPackage wurde in diesem Projekt bereits importiert.',
				'details': {
					'checksum_sha256': validated.checksum_sha256,
					'existing_version_id': response.data[0]['id'],
				},
			},
		)


def overlay_from_rpc_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
	if not rows or not isinstance(rows[0].get('payload'), dict):
		return {
			'version_id': None,
			'source_date': None,
			'type': 'FeatureCollection',
			'features': [],
		}

	return rows[0]['payload']


@router.post('/validate', response_model=WarnkarteValidationSummary)
def validate_warnkarte_upload(
	project_id: Annotated[str, Form()],
	file: Annotated[UploadFile, File()],
	token: Annotated[str, Depends(oauth2_scheme)],
):
	require_user(token)
	require_project_access(token, project_id, admin=True)
	validated = validate_upload(file)
	ensure_unique_checksum(token, project_id, validated)
	return validated.summary()


@router.post('/import', response_model=WarnkarteImportResponse)
def import_warnkarte(
	project_id: Annotated[str, Form()],
	confirmed_date: Annotated[date, Form()],
	file: Annotated[UploadFile, File()],
	token: Annotated[str, Depends(oauth2_scheme)],
):
	user = require_user(token)
	require_project_access(token, project_id, admin=True)
	validated = validate_upload(file)
	if confirmed_date != validated.source_date:
		raise HTTPException(
			status_code=status.HTTP_400_BAD_REQUEST,
			detail={
				'code': 'DATE_CONFIRMATION_MISMATCH',
				'message': 'Das bestätigte Datum muss dem maßgeblichen Datum im Dateinamen entsprechen.',
				'details': {
					'expected': validated.source_date.isoformat(),
					'confirmed': confirmed_date.isoformat(),
				},
			},
		)
	ensure_unique_checksum(token, project_id, validated)

	try:
		with use_service_client() as client:
			version_id = (
				client.rpc(
					'priwa_import_warnkarte',
					{
						'p_actor': str(user.id),
						'p_project_id': project_id,
						'p_source_filename': validated.source_filename,
						'p_checksum_sha256': validated.checksum_sha256,
						'p_source_date': validated.source_date.isoformat(),
						'p_source_layer': validated.source_layer,
						'p_source_crs': validated.source_crs,
						'p_polygons': [polygon.as_rpc_payload() for polygon in validated.polygons],
					},
				)
				.execute()
				.data
			)
	except Exception as error:
		if 'priwa_warnkarte_versions_project_checksum_key' in str(error):
			raise HTTPException(
				status_code=status.HTTP_409_CONFLICT,
				detail={
					'code': 'DUPLICATE_CHECKSUM',
					'message': 'Dieses GeoPackage wurde in diesem Projekt bereits importiert.',
					'details': {'checksum_sha256': validated.checksum_sha256},
				},
			) from error
		raise HTTPException(
			status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
			detail={
				'code': 'IMPORT_FAILED',
				'message': 'Die Warnkarte konnte nicht atomar importiert werden.',
				'details': {},
			},
		) from error

	return {'version_id': str(version_id), 'summary': validated.summary()}


@router.get('/versions', response_model=list[WarnkarteVersion])
def list_warnkarte_versions(
	project_id: str,
	token: Annotated[str, Depends(oauth2_scheme)],
):
	require_user(token)
	require_project_access(token, project_id, admin=True)
	with use_client(token) as client:
		versions = (
			client.table('priwa_warnkarte_versions')
			.select(
				'id,source_date,source_filename,checksum_sha256,source_layer,source_crs,'
				'feature_count,imported_by,imported_at'
			)
			.eq('project_id', project_id)
			.order('imported_at', desc=True)
			.execute()
		).data or []
		publication = (
			client.table('priwa_warnkarte_publications')
			.select('version_id')
			.eq('project_id', project_id)
			.order('published_at', desc=True)
			.order('id', desc=True)
			.limit(1)
			.execute()
		).data or []
	current_version_id = publication[0]['version_id'] if publication else None
	return [{**version, 'is_current': version['id'] == current_version_id} for version in versions]


@router.post('/versions/{version_id}/publish', response_model=WarnkartePublicationResponse)
def publish_warnkarte_version(
	version_id: str,
	token: Annotated[str, Depends(oauth2_scheme)],
):
	require_user(token)
	try:
		with use_client(token) as client:
			publication_id = client.rpc('priwa_publish_warnkarte', {'p_version_id': version_id}).execute().data
	except Exception as error:
		error_text = str(error)
		if 'admin access is required' in error_text:
			raise HTTPException(
				status_code=status.HTTP_403_FORBIDDEN,
				detail={
					'code': 'ADMIN_REQUIRED',
					'message': 'Nur PRIWA-Admins dürfen eine Warnkarte veröffentlichen.',
					'details': {},
				},
			) from error
		if 'Warnkarte version not found' in error_text:
			raise HTTPException(
				status_code=status.HTTP_404_NOT_FOUND,
				detail={
					'code': 'VERSION_NOT_FOUND',
					'message': 'Die Warnkartenversion wurde nicht gefunden.',
					'details': {'version_id': version_id},
				},
			) from error
		raise HTTPException(
			status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
			detail={
				'code': 'PUBLISH_FAILED',
				'message': 'Die Warnkarte konnte nicht veröffentlicht werden.',
				'details': {},
			},
		) from error
	return {'publication_id': publication_id, 'version_id': version_id}


@router.get('/active')
def get_active_warnkarte(
	project_id: str,
	token: Annotated[str, Depends(oauth2_scheme)],
):
	require_user(token)
	require_project_access(token, project_id, admin=False)
	with use_client(token) as client:
		rows = client.rpc('priwa_current_warnkarte', {'p_project_id': project_id}).execute().data or []
	return overlay_from_rpc_rows(rows)


@router.get('/versions/{version_id}/overlay')
def get_warnkarte_version_overlay(
	version_id: str,
	project_id: str,
	token: Annotated[str, Depends(oauth2_scheme)],
):
	require_user(token)
	require_project_access(token, project_id, admin=True)
	with use_client(token) as client:
		rows = (
			client.rpc(
				'priwa_warnkarte_version_overlay',
				{'p_project_id': project_id, 'p_version_id': version_id},
			)
			.execute()
			.data
			or []
		)
	if not rows:
		raise HTTPException(
			status_code=status.HTTP_404_NOT_FOUND,
			detail={
				'code': 'VERSION_NOT_FOUND',
				'message': 'Die Warnkartenversion wurde nicht gefunden.',
				'details': {'version_id': version_id},
			},
		)
	return overlay_from_rpc_rows(rows)
