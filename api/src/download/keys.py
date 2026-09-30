"""Cache keys for prepared download files.

A key names every request parameter that changes the file plus a content version,
so a changed dataset, ortho, metadata row, label, geometry, AOI or model preference
produces a new file name instead of serving an outdated cached file.
"""

import hashlib
import json
from typing import Any, Dict, Iterable, List, Optional, Tuple

from api.src.download.downloads import fetch_all_rows
from shared.db import use_service_client
from shared.labels import get_model_preferences
from shared.models import Dataset, LabelDataEnum
from shared.settings import settings

DatasetRows = Tuple[Dataset, Optional[Dict], Optional[Dict]]


def _digest(value: Any, length: int = 12) -> str:
	encoded = json.dumps(value, sort_keys=True, default=str).encode()
	return hashlib.sha256(encoded).hexdigest()[:length]


def _latest_geometry_change(client, label: Dict) -> Optional[str]:
	# Geometry edits insert rows or soft-delete them; both move the newest updated_at.
	table = (
		settings.deadwood_geometries_table
		if label.get('label_data') == LabelDataEnum.deadwood.value
		else settings.forest_cover_geometries_table
	)
	response = (
		client.table(table)
		.select('updated_at')
		.eq('label_id', label['id'])
		.not_.is_('updated_at', 'null')
		.order('updated_at', desc=True)
		.limit(1)
		.execute()
	)
	return response.data[0]['updated_at'] if response.data else None


def _labels_fingerprint(client, dataset_id: int) -> Dict:
	labels = fetch_all_rows(lambda: client.table(settings.labels_table).select('*').eq('dataset_id', dataset_id).order('id'))
	aois = fetch_all_rows(lambda: client.table(settings.aois_table).select('*').eq('dataset_id', dataset_id).order('id'))
	return {
		'labels': [{**label, 'latest_geometry_change': _latest_geometry_change(client, label)} for label in labels],
		'aois': aois,
	}


def content_version(datasets: Iterable[DatasetRows], include_labels: bool) -> str:
	"""Return a short hash over everything a prepared file is built from.

	Runs after the route's access check with the service client, like the label export itself.
	"""
	parts: List[Dict] = []
	with use_service_client() as client:
		for dataset, ortho, metadata in datasets:
			part = {'dataset': dataset.model_dump(), 'ortho': ortho, 'metadata': metadata}
			if include_labels:
				part.update(_labels_fingerprint(client, dataset.id))
			parts.append(part)
	if include_labels:
		parts.append({'model_preferences': {key.value: value for key, value in get_model_preferences().items()}})
	return _digest(parts)


def labels_content_version(dataset_id: int) -> str:
	with use_service_client() as client:
		fingerprint = _labels_fingerprint(client, dataset_id)
	fingerprint['model_preferences'] = {key.value: value for key, value in get_model_preferences().items()}
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
	"""Deterministic multi-dataset bundle ID; the dataset order does not matter."""
	return _digest([sorted(dataset_ids), include_labels, include_parquet, use_original_filename, version], 16)
