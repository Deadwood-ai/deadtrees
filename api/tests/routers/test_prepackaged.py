from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from api.src.routers.prepackaged import (
	DEFINITIONS_TABLE,
	GRANTS_TABLE,
	VERSIONS_TABLE,
	build_download_url,
	create_prepackaged_download_grant,
	generate_prepackaged_signed_download_url,
	hash_download_token,
	list_prepackaged_packages,
	normalize_prepackaged_storage_key,
	parse_original_path,
	parse_original_token,
)


def test_hash_download_token_is_stable_and_non_plaintext():
	token = 'example-token'

	token_hash = hash_download_token(token)

	assert token_hash == hash_download_token(token)
	assert token_hash != token
	assert len(token_hash) == 64


def test_build_download_url_uses_configured_file_name(monkeypatch):
	from api.src.routers import prepackaged

	monkeypatch.setattr(prepackaged.settings, 'PREPACKAGED_DOWNLOAD_BASE_URL', 'https://data.example/prepackaged/v1')

	download_url = build_download_url('/prepackaged/v1/tree-cover_2026.04.17.zip', 'signed-token')

	assert download_url == 'https://data.example/prepackaged/v1/tree-cover_2026.04.17.zip?token=signed-token'


def test_parse_original_path_drops_query_token():
	assert (
		parse_original_path('/prepackaged/v1/tree-cover.zip?token=signed-token')
		== '/prepackaged/v1/tree-cover.zip'
	)


def test_parse_original_token_reads_query_token():
	assert parse_original_token('/prepackaged/v1/tree-cover.zip?token=signed-token') == 'signed-token'
	assert parse_original_token('/prepackaged/v1/tree-cover.zip') is None


class FakeDataResponse:
	def __init__(self, data: list[dict]):
		self.data = data


class FakeDataQuery:
	def __init__(self, data: list[dict]):
		self.data = data
		self.filters: list[tuple[str, object]] = []
		self.order_fields: list[tuple[str, bool]] = []

	def select(self, *_args, **_kwargs):
		return self

	def eq(self, field: str, value: object):
		self.filters.append((field, value))
		return self

	def order(self, field: str, desc: bool = False):
		self.order_fields.append((field, desc))
		return self

	def execute(self):
		return FakeDataResponse([dict(row) for row in self.data])


class FakeCatalogClient:
	def __init__(self):
		self.queries: dict[str, FakeDataQuery] = {}

	def table(self, table_name: str):
		data_by_table = {
			DEFINITIONS_TABLE: [
				{
					'id': 1,
					'slug': 'tree-cover-aerial-global',
					'title': 'Tree cover aerial global',
					'summary': 'Tree cover summary',
					'description': None,
					'technical_description': 'Exact package definition',
					'source_repository_url': 'https://github.com/Deadwood-ai/prepackaged_datasets_dte',
					'source_file_path': 'deadtrees_prepackaged/datasets/tree_cover_aerial_global.py',
					'kind': 'vector',
					'sort_order': 10,
				}
			],
			VERSIONS_TABLE: [
				{
					'id': 7,
					'definition_id': 1,
					'version': '2026.04.17',
					'status': 'available',
					'file_name': 'tree-cover.zip',
					'public_download_path': '/prepackaged/v1/tree-cover.zip',
					'size_bytes': 123,
					'checksum_sha256': None,
					'dataset_count': 2,
					'artifact_count': 1,
					'built_at': None,
					'published_at': None,
					'source_commit': 'feffe7b73d2ec3159260a6d3fddf7e5ac9ae855a',
					'source_package_version': '0.1.0',
					'manifest': {},
					'known_issues': None,
				}
			],
		}
		query = FakeDataQuery(data_by_table[table_name])
		self.queries[table_name] = query
		return query


class FakeCatalogContext:
	def __init__(self, client: FakeCatalogClient):
		self.client = client

	def __enter__(self):
		return self.client

	def __exit__(self, *_args):
		return False


class FakeS3Client:
	def __init__(self):
		self.calls: list[dict] = []

	def generate_presigned_url(self, operation: str, Params: dict, ExpiresIn: int):
		self.calls.append({'operation': operation, 'Params': Params, 'ExpiresIn': ExpiresIn})
		return 'https://s3.example/prepackaged/v2026-04-17/tree-cover.zip?signed=1'


class FakeVersionClient:
	def __init__(self, version: dict):
		self.version = version
		self.queries: list[FakeDataQuery] = []

	def table(self, table_name: str):
		assert table_name == VERSIONS_TABLE
		query = FakeDataQuery([self.version])
		self.queries.append(query)
		return query


class FakeServiceInsertQuery:
	def __init__(self, client):
		self.client = client
		self.payload = None

	def insert(self, payload: dict):
		self.payload = payload
		self.client.inserted_payloads.append(payload)
		return self

	def execute(self):
		grant_id = f'grant-{len(self.client.inserted_payloads)}'
		return FakeDataResponse([{'id': grant_id}])


class FakeServiceClient:
	def __init__(self):
		self.table_names: list[str] = []
		self.inserted_payloads: list[dict] = []

	def table(self, table_name: str):
		assert table_name == GRANTS_TABLE
		self.table_names.append(table_name)
		return FakeServiceInsertQuery(self)


class FakeContext:
	def __init__(self, client):
		self.client = client

	def __enter__(self):
		return self.client

	def __exit__(self, *_args):
		return False


def make_available_version():
	return {
		'id': 7,
		'version': '2026.04.17',
		'status': 'available',
		'file_name': 'tree-cover.zip',
		'storage_path': 'prepackaged/v2026-04-17/tree-cover.zip',
		'public_download_path': '/prepackaged/v1/tree-cover.zip',
		'size_bytes': 123,
		'checksum_sha256': None,
		'dataset_count': 2,
		'artifact_count': 1,
		'built_at': None,
		'published_at': None,
		'manifest': {},
		'known_issues': None,
		'definition': {
			'id': 1,
			'slug': 'tree-cover-aerial-global',
			'title': 'Tree cover aerial global',
			'summary': 'Tree cover summary',
			'kind': 'vector',
			'is_active': True,
		},
	}


def test_normalize_prepackaged_storage_key_accepts_plain_key_and_s3_uri(monkeypatch):
	from api.src.routers import prepackaged

	monkeypatch.setattr(prepackaged.settings, 'PREPACKAGED_S3_BUCKET', 'frct-deadtrees-products')

	assert (
		normalize_prepackaged_storage_key('prepackaged/v2026-04-17/tree-cover.zip')
		== 'prepackaged/v2026-04-17/tree-cover.zip'
	)
	assert (
		normalize_prepackaged_storage_key('s3://frct-deadtrees-products/prepackaged/v2026-04-17/tree-cover.zip')
		== 'prepackaged/v2026-04-17/tree-cover.zip'
	)


def test_normalize_prepackaged_storage_key_rejects_local_paths_and_other_buckets(monkeypatch):
	from api.src.routers import prepackaged

	monkeypatch.setattr(prepackaged.settings, 'PREPACKAGED_S3_BUCKET', 'frct-deadtrees-products')

	for storage_path in (
		'/data/assets/prepackaged_datasets_out/tree-cover.zip',
		's3://other-bucket/prepackaged/v2026-04-17/tree-cover.zip',
		'',
	):
		with pytest.raises(HTTPException):
			normalize_prepackaged_storage_key(storage_path)


def test_generate_prepackaged_signed_download_url_uses_s3_get_object_params(monkeypatch):
	from api.src.routers import prepackaged

	monkeypatch.setattr(prepackaged.settings, 'PREPACKAGED_S3_BUCKET', 'frct-deadtrees-products')
	monkeypatch.setattr(prepackaged.settings, 'PREPACKAGED_SIGNED_URL_TTL_SECONDS', 1234)
	s3_client = FakeS3Client()

	download_url, storage_key = generate_prepackaged_signed_download_url(
		's3://frct-deadtrees-products/prepackaged/v2026-04-17/tree-cover.zip',
		'tree-cover.zip',
		s3_client=s3_client,
	)

	assert download_url.startswith('https://s3.example/')
	assert storage_key == 'prepackaged/v2026-04-17/tree-cover.zip'
	assert s3_client.calls == [
		{
			'operation': 'get_object',
			'Params': {
				'Bucket': 'frct-deadtrees-products',
				'Key': 'prepackaged/v2026-04-17/tree-cover.zip',
				'ResponseContentDisposition': 'attachment; filename="tree-cover.zip"',
			},
			'ExpiresIn': 1234,
		}
	]


def test_list_prepackaged_packages_is_public_service_read(monkeypatch):
	from api.src.routers import prepackaged

	client = FakeCatalogClient()
	monkeypatch.setattr(prepackaged, 'use_service_client', lambda: FakeCatalogContext(client))
	monkeypatch.setattr(prepackaged, 'require_user', lambda _token: (_ for _ in ()).throw(AssertionError('auth not required')))

	packages = list_prepackaged_packages()

	assert len(packages) == 1
	assert packages[0].slug == 'tree-cover-aerial-global'
	assert packages[0].technical_description == 'Exact package definition'
	assert packages[0].source_repository_url == 'https://github.com/Deadwood-ai/prepackaged_datasets_dte'
	assert packages[0].source_file_path == 'deadtrees_prepackaged/datasets/tree_cover_aerial_global.py'
	assert packages[0].versions[0].file_name == 'tree-cover.zip'
	assert packages[0].versions[0].source_commit == 'feffe7b73d2ec3159260a6d3fddf7e5ac9ae855a'
	assert packages[0].versions[0].source_package_version == '0.1.0'
	assert ('is_active', True) in client.queries[DEFINITIONS_TABLE].filters
	assert ('status', 'available') in client.queries[VERSIONS_TABLE].filters


def test_create_prepackaged_download_grant_returns_signed_url_and_audit_row(monkeypatch):
	from api.src.routers import prepackaged

	version_client = FakeVersionClient(make_available_version())
	service_client = FakeServiceClient()
	request = SimpleNamespace(
		headers={'authorization': 'Bearer user-token', 'user-agent': 'pytest', 'x-forwarded-for': '203.0.113.10'},
		client=SimpleNamespace(host='198.51.100.7'),
	)

	monkeypatch.setattr(prepackaged.settings, 'PREPACKAGED_S3_BUCKET', 'frct-deadtrees-products')
	monkeypatch.setattr(prepackaged.settings, 'PREPACKAGED_SIGNED_URL_TTL_SECONDS', 3600)
	monkeypatch.setattr(prepackaged, 'require_user', lambda _token: SimpleNamespace(id='user-1'))
	monkeypatch.setattr(prepackaged, 'use_client', lambda _token: FakeContext(version_client))
	monkeypatch.setattr(prepackaged, 'use_service_client', lambda: FakeContext(service_client))
	monkeypatch.setattr(
		prepackaged,
		'generate_prepackaged_signed_download_url',
		lambda _storage_path, _file_name: ('https://s3.example/tree-cover.zip?signed=1', 'prepackaged/v2026-04-17/tree-cover.zip'),
	)

	response = create_prepackaged_download_grant(7, request, authorization='Bearer user-token')

	assert response.grant_id == 'grant-1'
	assert response.version_id == 7
	assert response.download_url == 'https://s3.example/tree-cover.zip?signed=1'
	assert service_client.table_names == [GRANTS_TABLE]

	inserted_payload = service_client.inserted_payloads[0]
	assert inserted_payload['version_id'] == 7
	assert inserted_payload['user_id'] == 'user-1'
	assert inserted_payload['requested_ip'] == '203.0.113.10'
	assert inserted_payload['requested_user_agent'] == 'pytest'
	assert inserted_payload['token_hash'] != 'user-token'
	assert inserted_payload['extra'] == {
		'event': 'prepackaged_signed_download_created',
		'package_slug': 'tree-cover-aerial-global',
		'version': '2026.04.17',
		'file_name': 'tree-cover.zip',
		'size_bytes': 123,
		'storage_bucket': 'frct-deadtrees-products',
		'storage_key': 'prepackaged/v2026-04-17/tree-cover.zip',
	}


def test_create_prepackaged_download_grant_has_no_count_based_limit(monkeypatch):
	from api.src.routers import prepackaged

	version_client = FakeVersionClient(make_available_version())
	service_client = FakeServiceClient()
	request = SimpleNamespace(headers={}, client=SimpleNamespace(host='198.51.100.7'))

	monkeypatch.setattr(prepackaged, 'require_user', lambda _token: SimpleNamespace(id='user-1'))
	monkeypatch.setattr(prepackaged, 'use_client', lambda _token: FakeContext(version_client))
	monkeypatch.setattr(prepackaged, 'use_service_client', lambda: FakeContext(service_client))
	monkeypatch.setattr(
		prepackaged,
		'generate_prepackaged_signed_download_url',
		lambda _storage_path, _file_name: ('https://s3.example/tree-cover.zip?signed=1', 'prepackaged/v2026-04-17/tree-cover.zip'),
	)

	for _index in range(6):
		response = create_prepackaged_download_grant(7, request, authorization='Bearer user-token')
		assert response.download_url == 'https://s3.example/tree-cover.zip?signed=1'

	assert len(service_client.inserted_payloads) == 6
