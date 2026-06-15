from datetime import datetime, timedelta, timezone
import hashlib
import secrets
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

from fastapi import APIRouter, Header, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field

from shared.db import use_client, use_service_client, verify_token
from shared.logging import LogCategory, LogContext, SupabaseHandler, UnifiedLogger
from shared.settings import settings


router = APIRouter(prefix='/prepackaged', tags=['prepackaged'])
logger = UnifiedLogger(__name__)
logger.add_supabase_handler(SupabaseHandler())

DEFINITIONS_TABLE = 'prepackaged_dataset_definitions'
VERSIONS_TABLE = 'prepackaged_dataset_versions'
GRANTS_TABLE = 'prepackaged_dataset_download_grants'
S3_SIGNING_ERROR = 'Prepackaged dataset download signing is not configured'


class PrepackagedDatasetVersion(BaseModel):
	model_config = ConfigDict(extra='ignore')

	id: int
	version: str
	status: str
	file_name: str
	public_download_path: str
	size_bytes: int
	checksum_sha256: Optional[str] = None
	dataset_count: Optional[int] = None
	artifact_count: Optional[int] = None
	built_at: Optional[datetime] = None
	published_at: Optional[datetime] = None
	source_commit: Optional[str] = None
	source_package_version: Optional[str] = None
	manifest: dict[str, Any] = Field(default_factory=dict)
	known_issues: Optional[str] = None


class PrepackagedDatasetPackage(BaseModel):
	model_config = ConfigDict(extra='ignore')

	id: int
	slug: str
	title: str
	summary: str
	description: Optional[str] = None
	technical_description: Optional[str] = None
	source_repository_url: Optional[str] = None
	source_file_path: Optional[str] = None
	kind: str
	sort_order: int
	versions: list[PrepackagedDatasetVersion]


class PrepackagedDownloadGrantResponse(BaseModel):
	grant_id: str
	version_id: int
	expires_at: datetime
	download_url: str


def hash_download_token(token: str) -> str:
	return hashlib.sha256(token.encode('utf-8')).hexdigest()


def build_download_url(public_download_path: str, token: str) -> str:
	file_name = public_download_path.rstrip('/').split('/')[-1]
	return f'{settings.PREPACKAGED_DOWNLOAD_BASE_URL.rstrip("/")}/{file_name}?token={token}'


def normalize_prepackaged_storage_key(storage_path: Optional[str]) -> str:
	storage_key = (storage_path or '').strip()
	if not storage_key:
		raise HTTPException(status_code=500, detail='Prepackaged dataset version is missing a storage path')

	if storage_key.startswith('s3://'):
		parsed = urlparse(storage_key)
		if parsed.netloc and parsed.netloc != settings.PREPACKAGED_S3_BUCKET:
			raise HTTPException(status_code=500, detail='Prepackaged dataset version points at an unexpected S3 bucket')
		storage_key = parsed.path.lstrip('/')

	if storage_key.startswith('/'):
		raise HTTPException(status_code=500, detail='Prepackaged dataset version does not use an S3 object key')

	return storage_key.lstrip('/')


def build_content_disposition(file_name: str) -> str:
	safe_file_name = file_name.replace('"', '')
	return f'attachment; filename="{safe_file_name}"'


def create_prepackaged_s3_client():
	missing_settings = [
		name
		for name in (
			'PREPACKAGED_S3_ENDPOINT_URL',
			'PREPACKAGED_S3_REGION',
			'PREPACKAGED_S3_BUCKET',
			'PREPACKAGED_API_READ_S3_ACCESS_KEY',
			'PREPACKAGED_API_READ_S3_SECRET_KEY',
		)
		if not getattr(settings, name)
	]
	if missing_settings:
		logger.error(
			'Prepackaged S3 signing settings are missing',
			context=LogContext(
				category=LogCategory.DOWNLOAD,
				extra={'event': 'prepackaged_s3_signing_misconfigured', 'missing_settings': missing_settings},
			),
		)
		raise HTTPException(status_code=500, detail=S3_SIGNING_ERROR)

	try:
		import boto3
		from botocore.config import Config
	except ImportError as error:
		logger.error(
			'Prepackaged S3 signing dependency is missing',
			context=LogContext(
				category=LogCategory.DOWNLOAD,
				extra={'event': 'prepackaged_s3_signing_dependency_missing'},
			),
		)
		raise HTTPException(status_code=500, detail=S3_SIGNING_ERROR) from error

	return boto3.client(
		's3',
		endpoint_url=settings.PREPACKAGED_S3_ENDPOINT_URL,
		aws_access_key_id=settings.PREPACKAGED_API_READ_S3_ACCESS_KEY,
		aws_secret_access_key=settings.PREPACKAGED_API_READ_S3_SECRET_KEY,
		region_name=settings.PREPACKAGED_S3_REGION,
		config=Config(signature_version='s3v4', s3={'addressing_style': 'path'}),
	)


def generate_prepackaged_signed_download_url(
	storage_path: str,
	file_name: str,
	s3_client=None,
) -> tuple[str, str]:
	storage_key = normalize_prepackaged_storage_key(storage_path)
	client = s3_client or create_prepackaged_s3_client()
	download_url = client.generate_presigned_url(
		'get_object',
		Params={
			'Bucket': settings.PREPACKAGED_S3_BUCKET,
			'Key': storage_key,
			'ResponseContentDisposition': build_content_disposition(file_name),
		},
		ExpiresIn=settings.PREPACKAGED_SIGNED_URL_TTL_SECONDS,
	)
	return download_url, storage_key


def get_request_ip(request: Request) -> Optional[str]:
	forwarded_for = request.headers.get('x-forwarded-for')
	if forwarded_for:
		return forwarded_for.split(',')[0].strip()

	if request.client:
		return request.client.host

	return None


def parse_original_path(original_uri: Optional[str]) -> Optional[str]:
	if not original_uri:
		return None

	return urlparse(original_uri).path


def parse_original_token(original_uri: Optional[str]) -> Optional[str]:
	if not original_uri:
		return None

	token_values = parse_qs(urlparse(original_uri).query).get('token')
	if not token_values:
		return None

	return token_values[0]


def require_user(token: str):
	user = verify_token(token)
	if not user:
		raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid token')

	return user


def fetch_available_version(db_client, version_id: int) -> dict[str, Any]:
	response = (
		db_client.table(VERSIONS_TABLE)
		.select(
			'id,version,status,file_name,storage_path,public_download_path,size_bytes,checksum_sha256,'
			'dataset_count,artifact_count,built_at,published_at,manifest,known_issues,'
			'definition:prepackaged_dataset_definitions(id,slug,title,summary,kind,is_active)'
		)
		.eq('id', version_id)
		.eq('status', 'available')
		.execute()
	)

	if not response.data:
		raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Prepackaged dataset version not found')

	version = response.data[0]
	definition = version.get('definition') or {}
	if not definition.get('is_active', False):
		raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Prepackaged dataset version not found')

	return version


@router.get('/packages', response_model=list[PrepackagedDatasetPackage])
def list_prepackaged_packages():
	with use_service_client() as db_client:
		definition_response = (
			db_client.table(DEFINITIONS_TABLE)
			.select(
				'id,slug,title,summary,description,technical_description,'
				'source_repository_url,source_file_path,kind,sort_order'
			)
			.eq('is_active', True)
			.order('sort_order')
			.execute()
		)
		version_response = (
			db_client.table(VERSIONS_TABLE)
			.select(
				'id,definition_id,version,status,file_name,public_download_path,size_bytes,checksum_sha256,'
				'dataset_count,artifact_count,built_at,published_at,source_commit,source_package_version,'
				'manifest,known_issues'
			)
			.eq('status', 'available')
			.order('published_at', desc=True)
			.execute()
		)

	versions_by_definition: dict[int, list[PrepackagedDatasetVersion]] = {}
	for version in version_response.data or []:
		definition_id = version.pop('definition_id')
		versions_by_definition.setdefault(definition_id, []).append(PrepackagedDatasetVersion(**version))

	packages: list[PrepackagedDatasetPackage] = []
	for definition in definition_response.data or []:
		packages.append(
			PrepackagedDatasetPackage(
				**definition,
				versions=versions_by_definition.get(definition['id'], []),
			)
		)

	return packages


@router.post('/versions/{version_id}/download-grant', response_model=PrepackagedDownloadGrantResponse)
def create_prepackaged_download_grant(
	version_id: int,
	request: Request,
	authorization: str = Header(...),
):
	token = authorization.replace('Bearer ', '')
	user = require_user(token)
	audit_token = secrets.token_urlsafe(32)
	expires_at = datetime.now(timezone.utc) + timedelta(seconds=settings.PREPACKAGED_SIGNED_URL_TTL_SECONDS)

	with use_client(token) as db_client:
		version = fetch_available_version(db_client, version_id)

	download_url, storage_key = generate_prepackaged_signed_download_url(
		version['storage_path'],
		version['file_name'],
	)

	with use_service_client() as service_client:
		grant_response = (
			service_client.table(GRANTS_TABLE)
			.insert(
				{
					'version_id': version_id,
					'user_id': user.id,
					'token_hash': hash_download_token(audit_token),
					'expires_at': expires_at.isoformat(),
					'requested_ip': get_request_ip(request),
					'requested_user_agent': request.headers.get('user-agent'),
					'extra': {
						'event': 'prepackaged_signed_download_created',
						'package_slug': (version.get('definition') or {}).get('slug'),
						'version': version.get('version'),
						'file_name': version.get('file_name'),
						'size_bytes': version.get('size_bytes'),
						'storage_bucket': settings.PREPACKAGED_S3_BUCKET,
						'storage_key': storage_key,
					},
				}
			)
			.execute()
		)

	if not grant_response.data:
		raise HTTPException(status_code=500, detail='Failed to create download grant')

	grant = grant_response.data[0]
	logger.info(
		'Prepackaged signed download created',
		context=LogContext(
			category=LogCategory.DOWNLOAD,
			user_id=user.id,
			token=token,
			extra={
				'event': 'prepackaged_signed_download_created',
				'grant_id': grant['id'],
				'version_id': version_id,
				'file_name': version['file_name'],
				'storage_key': storage_key,
			},
		),
	)

	return PrepackagedDownloadGrantResponse(
		grant_id=grant['id'],
		version_id=version_id,
		expires_at=expires_at,
		download_url=download_url,
	)


@router.get('/grants/validate')
def validate_prepackaged_download_grant(
	token: Optional[str] = Query(default=None),
	x_download_token: Optional[str] = Header(default=None, alias='X-Download-Token'),
	x_original_uri: Optional[str] = Header(default=None, alias='X-Original-URI'),
):
	raw_download_token = token or x_download_token or parse_original_token(x_original_uri)
	if not raw_download_token:
		raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Missing download token')

	requested_path = parse_original_path(x_original_uri)
	now = datetime.now(timezone.utc)

	with use_service_client() as db_client:
		grant_response = (
			db_client.table(GRANTS_TABLE)
			.select(
				'id,expires_at,revoked_at,validation_count,'
				'version:prepackaged_dataset_versions(id,status,public_download_path,file_name)'
			)
			.eq('token_hash', hash_download_token(raw_download_token))
			.execute()
		)

		if not grant_response.data:
			raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid download token')

		grant = grant_response.data[0]
		version = grant.get('version') or {}
		expires_at = datetime.fromisoformat(grant['expires_at'].replace('Z', '+00:00'))

		if grant.get('revoked_at') is not None or expires_at <= now or version.get('status') != 'available':
			raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='Download grant is not active')

		if requested_path and requested_path != version.get('public_download_path'):
			raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail='Download grant does not match file')

		db_client.table(GRANTS_TABLE).update(
			{
				'last_validated_at': now.isoformat(),
				'validation_count': (grant.get('validation_count') or 0) + 1,
			}
		).eq('id', grant['id']).execute()

	return {'ok': True}
