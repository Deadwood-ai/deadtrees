"""Prepared download jobs: concurrency, failure handling, cache keys, bundle licensing, export access."""

import os
import shutil
import threading
import time
import zipfile
from pathlib import Path

import fiona
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from api.src.download import jobs
from api.src.download.jobs import ExportKind, JobState, Manifest, PreparedFileJob
from api.src.download.downloads import create_consolidated_geopackage, read_export_scope
from api.src.download.keys import get_bundle_filename, labels_content_version, prepared_job
from api.src.server import app
from shared.db import login, use_client, use_service_client
from shared.labels import create_label_with_geometries
from shared.models import LabelDataEnum, LabelPayloadData, LabelSourceEnum, LabelTypeEnum, LicenseEnum
from shared.settings import settings

# Fixtures shared with the main download tests.
from api.tests.routers.test_download import (  # noqa: F401
	_local_path,
	multi_test_datasets,
	private_test_dataset_for_download,
	test_dataset_for_download,
)

client = TestClient(app)
MANIFEST = Manifest(ExportKind.DATASET, (1,))

POLYGON = {
	'type': 'MultiPolygon',
	'coordinates': [[[[8.0, 48.0], [8.001, 48.0], [8.001, 48.001], [8.0, 48.001], [8.0, 48.0]]]],
}


def _leftovers(directory: Path) -> list[str]:
	return sorted(path.name for path in directory.iterdir())


# =============================================================================
# PreparedFileJob
# =============================================================================


def test_concurrent_claims_have_exactly_one_owner(tmp_path):
	job = PreparedFileJob(tmp_path / 'bundle.zip')
	barrier = threading.Barrier(8)
	results = []

	def claim():
		barrier.wait()
		results.append(job.claim())

	threads = [threading.Thread(target=claim) for _ in range(8)]
	for thread in threads:
		thread.start()
	for thread in threads:
		thread.join()

	assert results.count(True) == 1
	assert job.status().state == JobState.PROCESSING


def test_second_prepare_joins_live_build_without_touching_its_temp_file(tmp_path):
	job = PreparedFileJob(tmp_path / 'bundle.zip')
	started, release = threading.Event(), threading.Event()
	seen_temp = []

	def slow_build(target: Path):
		target.write_bytes(b'first job ')
		seen_temp.append(target)
		started.set()
		release.wait(5)
		with target.open('ab') as handle:
			handle.write(b'complete')

	assert job.claim()
	runner = threading.Thread(target=job.run, args=(slow_build, MANIFEST))
	runner.start()
	assert started.wait(5)

	# A concurrent request for the same key must not start a second build.
	assert job.claim() is False
	assert job.status().state == JobState.PROCESSING
	assert seen_temp[0].exists()

	release.set()
	runner.join()
	assert job.path.read_bytes() == b'first job complete'
	assert job.status().state == JobState.COMPLETED
	assert _leftovers(tmp_path) == ['bundle.zip', 'bundle.zip.manifest.json']


def test_parallel_runs_of_one_key_each_publish_a_complete_file(tmp_path):
	"""Even two builders of one key (e.g. after a stale takeover) never share or delete each other's temp."""
	job = PreparedFileJob(tmp_path / 'bundle.zip')
	barrier = threading.Barrier(2)

	def build(content: bytes):
		def write(target: Path):
			target.write_bytes(content[:4])
			barrier.wait(5)
			with target.open('ab') as handle:
				handle.write(content[4:])

		return write

	job.claim()
	runs = [threading.Thread(target=job.run, args=(build(content), MANIFEST)) for content in (b'AAAAaaaa', b'BBBBbbbb')]
	for run in runs:
		run.start()
	for run in runs:
		run.join()

	assert job.path.read_bytes() in (b'AAAAaaaa', b'BBBBbbbb')
	assert not job.error_path.exists()
	assert _leftovers(tmp_path) == ['bundle.zip', 'bundle.zip.manifest.json']


def test_failed_build_writes_error_marker_and_removes_temp_files(tmp_path):
	job = PreparedFileJob(tmp_path / 'labels.gpkg')

	def failing_build(target: Path):
		target.write_bytes(b'partial')
		(target.parent / 'scratch.csv').write_text('scratch')
		raise RuntimeError('synthetic failure')

	assert job.claim()
	job.run(failing_build, MANIFEST)

	status = job.status()
	assert status.state == JobState.FAILED
	assert status.message == 'synthetic failure'
	assert _leftovers(tmp_path) == ['labels.gpkg.error']


def test_empty_result_is_a_failure(tmp_path):
	job = PreparedFileJob(tmp_path / 'bundle.zip')
	assert job.claim()
	job.run(lambda target: target.touch(), MANIFEST)
	assert job.status().state == JobState.FAILED
	assert not job.path.exists()


def test_retry_after_failure_clears_the_error_marker(tmp_path):
	job = PreparedFileJob(tmp_path / 'bundle.zip')
	job.claim()
	job.run(lambda target: (_ for _ in ()).throw(RuntimeError('first attempt')), MANIFEST)
	assert job.status().state == JobState.FAILED

	assert job.claim()
	assert not job.error_path.exists()
	job.run(lambda target: target.write_bytes(b'ok'), MANIFEST)
	assert job.status().state == JobState.COMPLETED


def test_stale_inflight_marker_reports_failed_and_can_be_reclaimed(tmp_path):
	job = PreparedFileJob(tmp_path / 'bundle.zip')
	assert job.claim()  # a builder that then died with its process
	old = time.time() - jobs.STALE_AFTER_SECONDS - 60
	os.utime(job.inflight_path, (old, old))

	status = job.status()
	assert status.state == JobState.FAILED
	assert status.message == jobs.INTERRUPTED_MESSAGE

	assert job.claim()
	job.run(lambda target: target.write_bytes(b'rebuilt'), MANIFEST)
	assert job.status().state == JobState.COMPLETED


def test_heartbeat_keeps_a_long_build_fresh(tmp_path, monkeypatch):
	monkeypatch.setattr(jobs, 'HEARTBEAT_SECONDS', 0.05)
	monkeypatch.setattr(jobs, 'STALE_AFTER_SECONDS', 0.3)
	job = PreparedFileJob(tmp_path / 'bundle.zip')
	states = []

	def slow_build(target: Path):
		time.sleep(0.6)
		states.append(job.status().state)
		target.write_bytes(b'ok')

	assert job.claim()
	job.run(slow_build, MANIFEST)
	assert states == [JobState.PROCESSING]
	assert job.status().state == JobState.COMPLETED


def test_missing_job_is_reported_as_missing(tmp_path):
	assert PreparedFileJob(tmp_path / 'never.zip').status().state == JobState.MISSING


# =============================================================================
# Cache keys
# =============================================================================


def test_bundle_filename_names_every_variant_and_the_content_version():
	names = {
		get_bundle_filename(1, True, True, False, 'v1'),
		get_bundle_filename(1, False, True, False, 'v1'),
		get_bundle_filename(1, True, False, False, 'v1'),
		get_bundle_filename(1, True, True, True, 'v1'),
		get_bundle_filename(1, True, True, False, 'v2'),
	}
	assert len(names) == 5


def _prepare(url: str, auth_token: str, **params) -> dict:
	response = client.get(url, params=params, headers={'Authorization': f'Bearer {auth_token}'})
	assert response.status_code == 200, response.text
	return response.json()


def test_dataset_bundle_key_changes_with_original_filename_and_content(auth_token, private_test_dataset_for_download):
	dataset_id = private_test_dataset_for_download
	url = f'/api/v1/download/datasets/{dataset_id}/dataset.zip'
	try:
		first = _prepare(url, auth_token)
		assert first['status'] in ('processing', 'completed')
		status_url = f'/api/v1/download/datasets/{dataset_id}/status'
		first_path = _prepare(status_url, auth_token)['download_path']

		original = _prepare(url, auth_token, use_original_filename='true')
		original_path = _prepare(status_url, auth_token, use_original_filename='true')['download_path']
		assert original['status'] in ('processing', 'completed')
		assert original_path != first_path
		with zipfile.ZipFile(_local_path(original_path)) as archive:
			assert 'test-private-download.tif' in archive.namelist()

		with use_client(auth_token) as db_client:
			db_client.table(settings.datasets_table).update({'additional_information': 'edited after download'}).eq(
				'id', dataset_id
			).execute()

		# The edited dataset is not served from the old cache entry.
		stale_status = _prepare(status_url, auth_token)
		assert stale_status['status'] == 'failed'
		assert _prepare(url, auth_token)['status'] in ('processing', 'completed')
		second_path = _prepare(status_url, auth_token)['download_path']
		assert second_path != first_path
		with zipfile.ZipFile(_local_path(second_path)) as archive:
			metadata = archive.read('METADATA.csv').decode()
		assert 'edited after download' in metadata
	finally:
		shutil.rmtree(settings.downloads_path / str(dataset_id), ignore_errors=True)


def _labels_version(dataset_id: int, token: str) -> str:
	with use_client(token) as db_client:
		return labels_content_version(read_export_scope(db_client, dataset_id), token)


def test_labels_content_version_changes_when_a_geometry_is_edited(auth_token, private_test_dataset_for_download, test_user):
	dataset_id = private_test_dataset_for_download
	before = _labels_version(dataset_id, auth_token)
	label = create_label_with_geometries(_label_payload(dataset_id), test_user, auth_token)
	try:
		with_label = _labels_version(dataset_id, auth_token)
		assert with_label != before

		with use_client(auth_token) as db_client:
			geometry = (
				db_client.table(settings.deadwood_geometries_table).select('id').eq('label_id', label.id).execute().data[0]
			)
			time.sleep(0.01)
			db_client.table(settings.deadwood_geometries_table).update({'is_deleted': True}).eq(
				'id', geometry['id']
			).execute()
		assert _labels_version(dataset_id, auth_token) != with_label
	finally:
		_delete_labels(auth_token, dataset_id)


# =============================================================================
# Multi-dataset bundles
# =============================================================================


def _bundle(dataset_ids, auth_token, **params) -> dict:
	return _prepare(
		'/api/v1/download/bundle.zip', auth_token, dataset_ids=','.join(str(d) for d in dataset_ids), **params
	)


def _bundle_status(job_id: str, auth_token: str) -> dict:
	return _prepare('/api/v1/download/bundle/status', auth_token, job_id=job_id)


def test_bundle_with_missing_ortho_fails_and_reports_failed(auth_token, multi_test_datasets, data_directory):
	(data_directory / settings.archive_path / 'test-multi-1.tif').unlink()

	job_id = _bundle(multi_test_datasets, auth_token)['job_id']
	status = _bundle_status(job_id, auth_token)
	assert status['status'] == 'failed'
	assert str(multi_test_datasets[1]) in status['message']

	download = client.get(
		'/api/v1/download/bundle/download',
		params={'job_id': job_id},
		headers={'Authorization': f'Bearer {auth_token}'},
		follow_redirects=False,
	)
	assert download.status_code == 500
	assert _leftovers(settings.downloads_path / 'bundles') == [f'{job_id}.zip.error']


def test_mixed_license_bundle_contains_every_license(auth_token, multi_test_datasets):
	nc_dataset = multi_test_datasets[1]
	with use_client(auth_token) as db_client:
		db_client.table(settings.datasets_table).update({'license': LicenseEnum.cc_by_nc.value}).eq(
			'id', nc_dataset
		).execute()

	job_id = _bundle(multi_test_datasets, auth_token)['job_id']
	status = _bundle_status(job_id, auth_token)
	assert status['status'] == 'completed', status

	with zipfile.ZipFile(_local_path(status['download_path'])) as archive:
		license_text = archive.read('LICENSE.txt').decode()
		citation = archive.read('CITATION.cff').decode()
		with archive.open('METADATA.csv') as csv_file:
			metadata = pd.read_csv(csv_file)

	assert 'Attribution 4.0 International' in license_text
	assert 'Attribution-NonCommercial 4.0 International' in license_text
	assert f'CC BY-NC: datasets {nc_dataset}' in license_text
	assert 'CC BY-4.0' in citation and 'CC BY-NC-4.0' in citation
	licenses = dict(zip(metadata['deadtrees_id'], metadata['license']))
	assert licenses[nc_dataset] == LicenseEnum.cc_by_nc.value
	assert {licenses[d] for d in multi_test_datasets if d != nc_dataset} == {LicenseEnum.cc_by.value}


def test_bundle_key_changes_with_original_filename(auth_token, multi_test_datasets):
	original = _bundle(multi_test_datasets[:1], auth_token, use_original_filename='true')['job_id']
	by_id = _bundle(multi_test_datasets[:1], auth_token, use_original_filename='false')['job_id']
	assert original != by_id


def test_unknown_bundle_job_reports_failed_not_processing(auth_token):
	status = _bundle_status('0' * 28, auth_token)
	assert status['status'] == 'failed'

	response = client.get(
		'/api/v1/download/bundle/status',
		params={'job_id': '../etc'},
		headers={'Authorization': f'Bearer {auth_token}'},
	)
	assert response.status_code == 400


# =============================================================================
# Export reads use the service client after the route's access check
# =============================================================================


def _label_payload(dataset_id: int, geometry: dict = POLYGON) -> LabelPayloadData:
	return LabelPayloadData(
		dataset_id=dataset_id,
		label_source=LabelSourceEnum.visual_interpretation,
		label_type=LabelTypeEnum.segmentation,
		label_data=LabelDataEnum.deadwood,
		label_quality=1,
		geometry=geometry,
	)


def _delete_labels(auth_token: str, dataset_id: int) -> None:
	with use_client(auth_token) as db_client:
		for row in db_client.table(settings.labels_table).select('id').eq('dataset_id', dataset_id).execute().data:
			db_client.table(settings.deadwood_geometries_table).delete().eq('label_id', row['id']).execute()
		db_client.table(settings.labels_table).delete().eq('dataset_id', dataset_id).execute()


def test_private_dataset_labels_are_exported_when_the_default_key_is_anon(
	auth_token, private_test_dataset_for_download, test_user, monkeypatch
):
	"""The owner gets the private dataset's labels even if SUPABASE_KEY is the anon key."""
	dataset_id = private_test_dataset_for_download
	create_label_with_geometries(_label_payload(dataset_id), test_user, auth_token)
	monkeypatch.setattr(settings, 'SUPABASE_KEY', settings.SUPABASE_ANON_KEY)
	try:
		prepared = _prepare(f'/api/v1/download/datasets/{dataset_id}/labels.gpkg', auth_token)
		assert prepared['status'] in ('processing', 'completed')
		status = _prepare(f'/api/v1/download/datasets/{dataset_id}/labels/status', auth_token)
		assert status['status'] == 'completed', status

		gpkg = _local_path(status['download_path'])
		layer = f'deadwood_{LabelSourceEnum.visual_interpretation.value}'
		assert layer in fiona.listlayers(gpkg)
		with fiona.open(gpkg, layer=layer) as features:
			assert len(features) == 1
	finally:
		monkeypatch.undo()
		_delete_labels(auth_token, dataset_id)
		shutil.rmtree(settings.downloads_path / str(dataset_id), ignore_errors=True)


def test_label_export_includes_more_geometries_than_one_postgrest_page(
	auth_token, private_test_dataset_for_download, test_user, tmp_path
):
	"""PostgREST returns at most 1000 rows per request; the export must page until an empty page."""
	dataset_id = private_test_dataset_for_download
	squares = [
		[[[x, y], [x + 0.0001, y], [x + 0.0001, y + 0.0001], [x, y + 0.0001], [x, y]]]
		for x, y in ((8.0 + 0.0002 * (i % 40), 48.0 + 0.0002 * (i // 40)) for i in range(1500))
	]
	payload = _label_payload(dataset_id, {'type': 'MultiPolygon', 'coordinates': squares})
	create_label_with_geometries(payload, test_user, auth_token)
	try:
		with use_client(auth_token) as db_client:
			scope = read_export_scope(db_client, dataset_id)
		gpkg = create_consolidated_geopackage(dataset_id, scope, tmp_path / 'labels.gpkg')
		with fiona.open(gpkg, layer=f'deadwood_{LabelSourceEnum.visual_interpretation.value}') as features:
			assert len(features) == 1500
	finally:
		_delete_labels(auth_token, dataset_id)


def test_a_new_version_replaces_older_versions_of_the_same_variant_only(tmp_path):
	old = tmp_path / f'12_{"a" * 12}.zip'
	other_variant = tmp_path / f'12_nolabels_{"a" * 12}.zip'
	for path in (old, old.with_name(f'{old.name}.error'), old.with_name(f'{old.name}.manifest.json'), other_variant):
		path.write_bytes(b'old')

	job = prepared_job(tmp_path / f'12_{"b" * 12}.zip')
	assert job.claim()
	job.run(lambda target: target.write_bytes(b'new'), MANIFEST)

	assert _leftovers(tmp_path) == sorted([job.path.name, job.manifest_path.name, other_variant.name])


def test_bundle_versions_replace_older_versions_of_the_same_bundle(tmp_path):
	variant = '0123456789abcdef'
	older, other_bundle = tmp_path / f'{variant}{"a" * 12}.zip', tmp_path / f'{"f" * 16}{"a" * 12}.zip'
	for path in (older, other_bundle):
		path.write_bytes(b'old')

	job = prepared_job(tmp_path / f'{variant}{"b" * 12}.zip')
	assert job.claim()
	job.run(lambda target: target.write_bytes(b'new'), MANIFEST)

	assert _leftovers(tmp_path) == sorted([job.path.name, job.manifest_path.name, other_bundle.name])


def _hide_labels_from_non_owners(dataset_id: int, owner: str, rule: str) -> None:
	with use_service_client() as db_client:
		if rule == 'archived':
			db_client.table(settings.datasets_table).update({'archived': True}).eq('id', dataset_id).execute()
		else:
			db_client.table('dataset_audit').insert(
				{'dataset_id': dataset_id, 'audited_by': owner, 'final_assessment': 'exclude_completely'}
			).execute()


@pytest.mark.parametrize('rule', ['archived', 'exclude_completely'])
def test_downloads_contain_only_labels_the_user_may_read(
	rule, auth_token, test_dataset_for_download, test_user, test_user2
):
	"""Label policies hide these labels from other users; downloads must not bypass them."""
	dataset_id = test_dataset_for_download
	create_label_with_geometries(_label_payload(dataset_id), test_user, auth_token)
	_hide_labels_from_non_owners(dataset_id, test_user, rule)
	other_token = login(settings.TEST_USER_EMAIL2, settings.TEST_USER_PASSWORD2)
	labels_url = f'/api/v1/download/datasets/{dataset_id}/labels.gpkg'
	labels_status_url = f'/api/v1/download/datasets/{dataset_id}/labels/status'
	try:
		_prepare(labels_url, auth_token)
		owner_status = _prepare(labels_status_url, auth_token)
		assert owner_status['status'] == 'completed', owner_status

		_prepare(labels_url, other_token)
		other_status = _prepare(labels_status_url, other_token)
		assert other_status['status'] == 'failed', other_status
		assert not other_status.get('download_path')

		dataset_url = f'/api/v1/download/datasets/{dataset_id}/dataset.zip'
		_prepare(dataset_url, other_token)
		bundle_status = _prepare(f'/api/v1/download/datasets/{dataset_id}/status', other_token)
		assert bundle_status['status'] == 'completed', bundle_status
		zip_path = _local_path(bundle_status['download_path'])
		with zipfile.ZipFile(zip_path) as archive:
			assert not [name for name in archive.namelist() if name.startswith('labels_')]
	finally:
		with use_service_client() as db_client:
			db_client.table('dataset_audit').delete().eq('dataset_id', dataset_id).execute()
			db_client.table(settings.datasets_table).update({'archived': False}).eq('id', dataset_id).execute()
		_delete_labels(auth_token, dataset_id)
		shutil.rmtree(settings.downloads_path / str(dataset_id), ignore_errors=True)
