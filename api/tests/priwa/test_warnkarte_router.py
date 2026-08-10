from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from io import BytesIO
from types import SimpleNamespace

from fastapi import HTTPException, UploadFile
import pytest

from api.src.priwa.warnkarte import (
	ValidatedWarnkarte,
	ValidatedWarnkartePolygon,
	WarnkarteValidationError,
)
from api.src.routers import priwa_warnkarte


pytestmark = pytest.mark.unit


def validated_warnkarte():
	return ValidatedWarnkarte(
		source_filename='warnkarte_2024-06-25.gpkg',
		checksum_sha256='a' * 64,
		source_date=date(2024, 6, 25),
		source_layer='warning_polygons',
		source_crs='EPSG:32632',
		polygons=(
			ValidatedWarnkartePolygon(
				fid=1,
				probability=Decimal('0.6'),
				wkb_hex='00',
			),
		),
		warnings=(),
	)


def test_aggregated_member_overlay_is_returned_without_row_truncation():
	features = [
		{
			'type': 'Feature',
			'geometry': {'type': 'Polygon', 'coordinates': []},
			'properties': {'probability': 0.6},
		}
		for _ in range(1001)
	]
	response = priwa_warnkarte.overlay_from_rpc_rows(
		[
			{
				'payload': {
					'version_id': None,
					'source_date': '2024-06-25',
					'type': 'FeatureCollection',
					'features': features,
				}
			}
		]
	)

	assert response['version_id'] is None
	assert response['source_date'] == '2024-06-25'
	assert len(response['features']) == 1001
	assert response['features'] == features


def test_validation_error_keeps_structured_expected_and_detected_crs(monkeypatch):
	def reject(*_args, **_kwargs):
		raise WarnkarteValidationError(
			'INVALID_CRS',
			'Das Koordinatenreferenzsystem muss eindeutig EPSG:32632 sein.',
			details={'expected': 'EPSG:32632', 'detected': 'EPSG:4326'},
		)

	monkeypatch.setattr(priwa_warnkarte, 'validate_warnkarte_file', reject)
	upload = UploadFile(file=BytesIO(b'gpkg'), filename='warnkarte_2024-06-25.gpkg')

	with pytest.raises(HTTPException) as error:
		priwa_warnkarte.validate_upload(upload)

	assert error.value.status_code == 400
	assert error.value.detail == {
		'code': 'INVALID_CRS',
		'message': 'Das Koordinatenreferenzsystem muss eindeutig EPSG:32632 sein.',
		'details': {'expected': 'EPSG:32632', 'detected': 'EPSG:4326'},
	}


def test_resource_limit_validation_error_returns_structured_413(monkeypatch):
	def reject(*_args, **_kwargs):
		raise WarnkarteValidationError(
			'FILE_TOO_LARGE',
			'Das GeoPackage ist zu groß.',
			details={'max_bytes': 50 * 1024 * 1024},
			status_code=413,
		)

	monkeypatch.setattr(priwa_warnkarte, 'validate_warnkarte_file', reject)
	upload = UploadFile(file=BytesIO(b'gpkg'), filename='warnkarte_2024-06-25.gpkg')

	with pytest.raises(HTTPException) as error:
		priwa_warnkarte.validate_upload(upload)

	assert error.value.status_code == 413
	assert error.value.detail['code'] == 'FILE_TOO_LARGE'
	assert error.value.detail['details']['max_bytes'] == 50 * 1024 * 1024


def test_date_confirmation_mismatch_stops_before_any_database_write(monkeypatch):
	monkeypatch.setattr(priwa_warnkarte, 'require_user', lambda _token: object())
	monkeypatch.setattr(
		priwa_warnkarte,
		'require_project_access',
		lambda _token, _project_id, admin: None,
	)
	monkeypatch.setattr(priwa_warnkarte, 'validate_upload', lambda _file: validated_warnkarte())
	monkeypatch.setattr(
		priwa_warnkarte,
		'ensure_unique_checksum',
		lambda *_args: pytest.fail('duplicate lookup must not run before date confirmation'),
	)
	upload = UploadFile(file=BytesIO(b'gpkg'), filename='warnkarte_2024-06-25.gpkg')

	with pytest.raises(HTTPException) as error:
		priwa_warnkarte.import_warnkarte(
			project_id='project-1',
			confirmed_date=date(2024, 6, 26),
			file=upload,
			token='token',
		)

	assert error.value.status_code == 400
	assert error.value.detail['code'] == 'DATE_CONFIRMATION_MISMATCH'


def test_import_uses_service_only_rpc_with_verified_actor(monkeypatch):
	client = FakeClient('version-1')

	@contextmanager
	def use_fake_service_client():
		yield client

	monkeypatch.setattr(priwa_warnkarte, 'require_user', lambda _token: SimpleNamespace(id='actor-1'))
	monkeypatch.setattr(
		priwa_warnkarte,
		'require_project_access',
		lambda _token, _project_id, admin: None,
	)
	monkeypatch.setattr(priwa_warnkarte, 'validate_upload', lambda _file: validated_warnkarte())
	monkeypatch.setattr(priwa_warnkarte, 'ensure_unique_checksum', lambda *_args: None)
	monkeypatch.setattr(priwa_warnkarte, 'use_service_client', use_fake_service_client)
	upload = UploadFile(file=BytesIO(b'gpkg'), filename='warnkarte_2024-06-25.gpkg')

	response = priwa_warnkarte.import_warnkarte(
		project_id='project-1',
		confirmed_date=date(2024, 6, 25),
		file=upload,
		token='token',
	)

	assert response['version_id'] == 'version-1'
	assert client.calls[0][0] == 'priwa_import_warnkarte'
	assert client.calls[0][1]['p_actor'] == 'actor-1'
	assert client.calls[0][1]['p_project_id'] == 'project-1'


class FakeRpc:
	def __init__(self, result):
		self.result = result

	def execute(self):
		if isinstance(self.result, Exception):
			raise self.result
		return type('Response', (), {'data': self.result})()


class FakeClient:
	def __init__(self, result):
		self.result = result
		self.calls = []

	def rpc(self, name, payload):
		self.calls.append((name, payload))
		return FakeRpc(self.result)


def test_project_access_uses_database_admin_authorization(monkeypatch):
	client = FakeClient(False)

	@contextmanager
	def use_fake_client(_token):
		yield client

	monkeypatch.setattr(priwa_warnkarte, 'use_client', use_fake_client)

	with pytest.raises(HTTPException) as error:
		priwa_warnkarte.require_project_access('token', 'project-1', admin=True)

	assert error.value.status_code == 403
	assert error.value.detail['code'] == 'ADMIN_REQUIRED'
	assert client.calls == [('priwa_is_project_admin', {'p_project_id': 'project-1'})]


@pytest.mark.parametrize(
	('error_text', 'expected_status', 'expected_code'),
	[
		('Warnkarte current version cannot be archived', 409, 'CURRENT_VERSION_ARCHIVE_FORBIDDEN'),
		('Warnkarte archived version cannot be published', 409, 'ARCHIVED_VERSION_PUBLISH_FORBIDDEN'),
		('Warnkarte version not found', 404, 'VERSION_NOT_FOUND'),
		('PRIWA project admin access is required', 403, 'ADMIN_REQUIRED'),
	],
)
def test_version_action_database_errors_are_structured(
	monkeypatch,
	error_text,
	expected_status,
	expected_code,
):
	client = FakeClient(Exception(error_text))

	@contextmanager
	def use_fake_client(_token):
		yield client

	monkeypatch.setattr(priwa_warnkarte, 'use_client', use_fake_client)

	with pytest.raises(HTTPException) as error:
		priwa_warnkarte.run_version_rpc(
			'token',
			'priwa_archive_warnkarte',
			'version-1',
			failure_code='ARCHIVE_FAILED',
			failure_message='Archivierung fehlgeschlagen.',
		)

	assert error.value.status_code == expected_status
	assert error.value.detail['code'] == expected_code
	expected_details = {} if expected_code == 'ADMIN_REQUIRED' else {'version_id': 'version-1'}
	assert error.value.detail['details'] == expected_details


def test_archive_and_restore_endpoints_use_authenticated_database_rpcs(monkeypatch):
	client = FakeClient(42)

	@contextmanager
	def use_fake_client(_token):
		yield client

	monkeypatch.setattr(priwa_warnkarte, 'require_user', lambda _token: object())
	monkeypatch.setattr(priwa_warnkarte, 'use_client', use_fake_client)

	archived = priwa_warnkarte.archive_warnkarte_version('version-1', 'token')
	restored = priwa_warnkarte.restore_warnkarte_version('version-1', 'token')

	assert archived == {'version_id': 'version-1', 'is_archived': True}
	assert restored == {'version_id': 'version-1', 'is_archived': False}
	assert client.calls == [
		('priwa_archive_warnkarte', {'p_version_id': 'version-1'}),
		('priwa_restore_warnkarte', {'p_version_id': 'version-1'}),
	]


def test_unknown_archive_database_error_uses_operation_specific_failure(monkeypatch):
	client = FakeClient(Exception('database unavailable'))

	@contextmanager
	def use_fake_client(_token):
		yield client

	monkeypatch.setattr(priwa_warnkarte, 'use_client', use_fake_client)

	with pytest.raises(HTTPException) as error:
		priwa_warnkarte.run_version_rpc(
			'token',
			'priwa_archive_warnkarte',
			'version-1',
			failure_code='ARCHIVE_FAILED',
			failure_message='Archivierung fehlgeschlagen.',
		)

	assert error.value.status_code == 500
	assert error.value.detail == {
		'code': 'ARCHIVE_FAILED',
		'message': 'Archivierung fehlgeschlagen.',
		'details': {},
	}
