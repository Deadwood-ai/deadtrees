import os
from pathlib import Path

from processor.src.utils.debug_artifacts import (
	_env_bool,
	_env_int,
	retain_failed_artifacts_enabled_for_dataset,
	debug_bundle_base_dir,
	dt_resource_labels,
)


def test_env_bool_parsing(monkeypatch):
	monkeypatch.delenv('DT_TEST_BOOL', raising=False)
	assert _env_bool('DT_TEST_BOOL', default=False) is False
	assert _env_bool('DT_TEST_BOOL', default=True) is True

	monkeypatch.setenv('DT_TEST_BOOL', 'true')
	assert _env_bool('DT_TEST_BOOL', default=False) is True
	monkeypatch.setenv('DT_TEST_BOOL', '1')
	assert _env_bool('DT_TEST_BOOL', default=False) is True
	monkeypatch.setenv('DT_TEST_BOOL', 'yes')
	assert _env_bool('DT_TEST_BOOL', default=False) is True
	monkeypatch.setenv('DT_TEST_BOOL', 'on')
	assert _env_bool('DT_TEST_BOOL', default=False) is True

	monkeypatch.setenv('DT_TEST_BOOL', 'false')
	assert _env_bool('DT_TEST_BOOL', default=True) is False
	monkeypatch.setenv('DT_TEST_BOOL', '0')
	assert _env_bool('DT_TEST_BOOL', default=True) is False


def test_env_int_parsing(monkeypatch):
	monkeypatch.delenv('DT_TEST_INT', raising=False)
	assert _env_int('DT_TEST_INT', default=123) == 123

	monkeypatch.setenv('DT_TEST_INT', '456')
	assert _env_int('DT_TEST_INT', default=123) == 456

	monkeypatch.setenv('DT_TEST_INT', 'not-an-int')
	assert _env_int('DT_TEST_INT', default=123) == 123


def test_retain_failed_artifacts_allowlist(monkeypatch):
	# Default off
	monkeypatch.delenv('DT_RETAIN_FAILED_ARTIFACTS', raising=False)
	monkeypatch.delenv('DT_RETAIN_DATASET_IDS', raising=False)
	assert retain_failed_artifacts_enabled_for_dataset(1) is False

	# Enabled for all datasets
	monkeypatch.setenv('DT_RETAIN_FAILED_ARTIFACTS', 'true')
	monkeypatch.delenv('DT_RETAIN_DATASET_IDS', raising=False)
	assert retain_failed_artifacts_enabled_for_dataset(1) is True
	assert retain_failed_artifacts_enabled_for_dataset(999) is True

	# Enabled but allowlisted
	monkeypatch.setenv('DT_RETAIN_DATASET_IDS', '5, 7,not-a-number,')
	assert retain_failed_artifacts_enabled_for_dataset(5) is True
	assert retain_failed_artifacts_enabled_for_dataset(7) is True
	assert retain_failed_artifacts_enabled_for_dataset(6) is False


def test_debug_bundle_base_dir_override(monkeypatch, tmp_path):
	monkeypatch.setenv('DT_DEBUG_BUNDLE_DIR', str(tmp_path / 'bundles'))
	assert debug_bundle_base_dir() == Path(tmp_path / 'bundles')


def test_dt_resource_labels_shape(monkeypatch):
	# Stabilize env-dependent ttl in label shape checks
	monkeypatch.setenv('DT_RETAIN_FAILED_TTL_HOURS', '12')
	labels = dt_resource_labels(dataset_id=123, stage='odm', keep_eligible=True)
	assert labels['dt'] == 'odm'
	assert labels['dt_dataset_id'] == '123'
	assert labels['dt_stage'] == 'odm'
	assert labels['dt_keep'] == 'true'
	assert labels['dt_ttl_hours'] == '12'
	assert int(labels['dt_created_at_unix']) > 0

