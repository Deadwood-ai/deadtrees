"""Cache keys for prepared download files.

A key names every request parameter that changes the file plus a content version,
so a changed dataset, ortho, metadata row, label, geometry, AOI or model preference
produces a new file name instead of serving an outdated cached file. The version
covers only the labels and AOIs the requesting user may read, so users who see
different labels get different files.
"""

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from api.src.download.downloads import ExportScope
from api.src.download.jobs import PreparedFileJob
from shared.db import use_client
from shared.labels import get_model_preferences
from shared.models import Dataset, Label, LabelDataEnum
from shared.settings import settings

# (dataset, ortho, metadata, labels); labels is None when the file has no labels
DatasetRows = Tuple[Dataset, Optional[Dict], Optional[Dict], Optional[ExportScope]]


VERSION_LENGTH = 12
# <variant><optional "_"><version><suffix>, e.g. 12_nolabels_<version>.zip or <bundle variant><version>.zip
_VERSIONED_NAME = re.compile(rf'(?P<variant>.+?)(?P<sep>_?)[0-9a-f]{{{VERSION_LENGTH}}}(?P<suffix>\.[a-z]+)')


def prepared_job(path: Path) -> PreparedFileJob:
	"""A job for a versioned download file that replaces older versions of the same variant."""
	parts = _VERSIONED_NAME.fullmatch(path.name)
	if parts is None:
		raise ValueError(f'Not a versioned download file name: {path.name}')
	supersedes = re.compile(
		re.escape(parts['variant'] + parts['sep']) + f'[0-9a-f]{{{VERSION_LENGTH}}}' + re.escape(parts['suffix'])
	)
	return PreparedFileJob(path, supersedes=supersedes)


def _digest(value: Any, length: int = VERSION_LENGTH) -> str:
	encoded = json.dumps(value, sort_keys=True, default=str).encode()
	return hashlib.sha256(encoded).hexdigest()[:length]


def _latest_geometry_change(client, label: Label) -> Optional[str]:
	# Geometry edits insert rows or soft-delete them; both move the newest updated_at.
	table = (
		settings.deadwood_geometries_table
		if label.label_data == LabelDataEnum.deadwood
		else settings.forest_cover_geometries_table
	)
	response = (
		client.table(table)
		.select('updated_at')
		.eq('label_id', label.id)
		.not_.is_('updated_at', 'null')
		.order('updated_at', desc=True)
		.limit(1)
		.execute()
	)
	return response.data[0]['updated_at'] if response.data else None


def _labels_fingerprint(client, scope: ExportScope) -> Dict:
	return {
		'labels': [
			{**label.model_dump(), 'latest_geometry_change': _latest_geometry_change(client, label)}
			for label in scope.labels
		],
		'aois': scope.aois,
	}


def _model_preferences() -> Dict:
	return {key.value: value for key, value in get_model_preferences().items()}


def content_version(datasets: Iterable[DatasetRows], token: str) -> str:
	"""Return a short hash over everything a prepared file is built from, as the user sees it."""
	rows = list(datasets)
	parts: List[Dict] = [
		{'dataset': dataset.model_dump(), 'ortho': ortho, 'metadata': metadata} for dataset, ortho, metadata, _ in rows
	]
	scoped = [(part, labels) for part, (*_, labels) in zip(parts, rows) if labels is not None]
	if scoped:
		with use_client(token) as client:
			for part, labels in scoped:
				part.update(_labels_fingerprint(client, labels))
		parts.append({'model_preferences': _model_preferences()})
	return _digest(parts)


def labels_content_version(scope: ExportScope, token: str) -> str:
	with use_client(token) as client:
		fingerprint = _labels_fingerprint(client, scope)
	fingerprint['model_preferences'] = _model_preferences()
	return _digest(fingerprint)


def get_bundle_filename(
	dataset_id: int,
	include_labels: bool,
	include_parquet: bool,
	use_original_filename: bool,
	version: str,
) -> str:
	parts = [str(dataset_id)]
	if not include_labels:
		parts.append('nolabels')
	if not include_parquet:
		parts.append('noparquet')
	if use_original_filename:
		parts.append('original')
	parts.append(version)
	return '_'.join(parts) + '.zip'


def get_labels_filename(dataset_id: int, version: str) -> str:
	return f'{dataset_id}_labels_{version}.gpkg'


def generate_bundle_job_id(
	dataset_ids: List[int],
	include_labels: bool,
	include_parquet: bool,
	use_original_filename: bool,
	version: str,
) -> str:
	"""Deterministic multi-dataset bundle ID: a variant hash (dataset order does not matter) plus the version."""
	return _digest([sorted(dataset_ids), include_labels, include_parquet, use_original_filename], 16) + version
