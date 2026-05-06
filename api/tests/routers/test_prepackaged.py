import pytest
from fastapi import HTTPException

from api.src.routers.prepackaged import (
	DEFINITIONS_TABLE,
	GRANTS_TABLE,
	VERSIONS_TABLE,
	build_download_url,
	enforce_global_prepackaged_grant_limit,
	enforce_user_prepackaged_grant_limit,
	hash_download_token,
	list_prepackaged_packages,
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


class FakeCountResponse:
	def __init__(self, count: int):
		self.count = count


class FakeCountQuery:
	def __init__(self, count: int):
		self.count = count
		self.filters: list[tuple[str, object]] = []

	def select(self, *_args, **_kwargs):
		return self

	def eq(self, field: str, value: object):
		self.filters.append((field, value))
		return self

	def gte(self, field: str, value: object):
		self.filters.append((field, value))
		return self

	def execute(self):
		return FakeCountResponse(self.count)


class FakeCountClient:
	def __init__(self, count: int):
		self.count = count
		self.queries: list[FakeCountQuery] = []
		self.table_names: list[str] = []

	def table(self, table_name: str):
		self.table_names.append(table_name)
		query = FakeCountQuery(self.count)
		self.queries.append(query)
		return query


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


def test_user_grant_limit_filters_by_user(monkeypatch):
	from api.src.routers import prepackaged

	monkeypatch.setattr(prepackaged.settings, 'PREPACKAGED_GRANTS_PER_USER_PER_DAY', 2)
	client = FakeCountClient(count=1)

	enforce_user_prepackaged_grant_limit(client, 'user-1', 'token')

	assert client.table_names == [GRANTS_TABLE]
	assert ('user_id', 'user-1') in client.queries[0].filters


def test_list_prepackaged_packages_is_public_service_read(monkeypatch):
	from api.src.routers import prepackaged

	client = FakeCatalogClient()
	monkeypatch.setattr(prepackaged, 'use_service_client', lambda: FakeCatalogContext(client))
	monkeypatch.setattr(prepackaged, 'require_user', lambda _token: (_ for _ in ()).throw(AssertionError('auth not required')))

	packages = list_prepackaged_packages()

	assert len(packages) == 1
	assert packages[0].slug == 'tree-cover-aerial-global'
	assert packages[0].versions[0].file_name == 'tree-cover.zip'
	assert ('is_active', True) in client.queries[DEFINITIONS_TABLE].filters
	assert ('status', 'available') in client.queries[VERSIONS_TABLE].filters


def test_user_grant_limit_blocks_at_threshold(monkeypatch):
	from api.src.routers import prepackaged

	monkeypatch.setattr(prepackaged.settings, 'PREPACKAGED_GRANTS_PER_USER_PER_DAY', 2)
	client = FakeCountClient(count=2)

	with pytest.raises(HTTPException) as exc:
		enforce_user_prepackaged_grant_limit(client, 'user-1', 'token')

	assert exc.value.status_code == 429


def test_global_grant_limit_does_not_filter_by_user(monkeypatch):
	from api.src.routers import prepackaged

	monkeypatch.setattr(prepackaged.settings, 'PREPACKAGED_GRANTS_GLOBAL_PER_DAY', 6)
	client = FakeCountClient(count=5)

	enforce_global_prepackaged_grant_limit(client, 'user-1', 'token')

	assert client.table_names == [GRANTS_TABLE]
	assert not any(field == 'user_id' for field, _value in client.queries[0].filters)


def test_global_grant_limit_blocks_at_threshold(monkeypatch):
	from api.src.routers import prepackaged

	monkeypatch.setattr(prepackaged.settings, 'PREPACKAGED_GRANTS_GLOBAL_PER_DAY', 6)
	client = FakeCountClient(count=6)

	with pytest.raises(HTTPException) as exc:
		enforce_global_prepackaged_grant_limit(client, 'user-1', 'token')

	assert exc.value.status_code == 429
