import hashlib
import json
from pathlib import Path

from shared.db import use_client
from shared.logger import logger
from shared.logging import LogCategory, LogContext
from shared.models import Cog, Ortho
from shared.settings import settings

from .dataset_evaluation_v1.check import evaluate, store_payload
from .dataset_evaluation_v1.inputs import read_inputs
from .dataset_evaluation_v1.models import Model, default_models
from .dataset_evaluation_v1.rules import PHASH_METHOD, phash
from .utils.ssh import pull_file_from_storage_server, push_file_to_storage_server
from .utils.stored_inputs import local_cog, select_aoi


def run_dataset_evaluation(
	run_id: int, dataset_id: int, token: str, temp_dir: Path, models: list[Model] | None = None
) -> str:
	"""Evaluate one dataset for an existing queued or running audit.runs row.

	Reads the stored COG (private datasets too), runs the band and duplicate rules
	and the models, uploads the judged images to the storage server and stores the
	run with audit.store_dataset_evaluation. Returns the dataset verdict. A model
	that cannot be reached raises ModelUnavailable: the caller (the audit worker,
	DT-1482) keeps the run queued. Nothing is written when a step fails.
	"""
	temp_dir = Path(temp_dir)
	ctx = LogContext(category=LogCategory.PROCESS, dataset_id=dataset_id, token=token, extra={'run_id': run_id})
	cog, ortho, thumbnail_path, aoi = _fetch_inputs(token, dataset_id)
	if not ortho.sha256:
		raise ValueError('The ortho has no sha256; the ortho stage must run first')
	cog_file = local_cog(cog, temp_dir, token, dataset_id, ctx)
	thumbnail = _local_thumbnail(thumbnail_path, temp_dir, token, dataset_id)
	inputs = read_inputs(str(cog_file), aoi, seed=dataset_id)
	image_hash = phash(inputs.overview, inputs.valid)
	with use_client(token) as client:
		candidates = (
			client.schema('audit')
			.rpc('duplicate_candidates', {'p_dataset_id': dataset_id, 'p_hash': image_hash, 'p_method': PHASH_METHOD})
			.execute()
			.data
		)
	evaluation = evaluate(
		inputs,
		models if models is not None else default_models(),
		ortho_sha256=ortho.sha256,
		source_profile=(ortho.ortho_info or {}).get('Profile'),
		image_hash=image_hash,
		duplicate_candidates=candidates or [],
		thumbnail=thumbnail,
		aoi_key=aoi_key(aoi),
	)
	payload = store_payload(evaluation, inputs, dataset_id, ortho.sha256)
	# Files first, rows second: a stored row always points at an uploaded image.
	for image, row in zip(evaluation.images, payload['images']):
		local = temp_dir / f'evaluation-{image.name}'
		local.write_bytes(image.data)
		push_file_to_storage_server(
			str(local), f'{settings.STORAGE_SERVER_DATA_PATH}/{row["storage_path"]}', token, dataset_id
		)
	with use_client(token) as client:
		client.schema('audit').rpc('store_dataset_evaluation', {'p_run_id': run_id, 'p_result': payload}).execute()
	verdict = evaluation.verdict
	logger.info(
		'Dataset evaluation stored',
		LogContext(
			category=LogCategory.PROCESS,
			dataset_id=dataset_id,
			token=token,
			extra={
				'run_id': run_id,
				'verdict': verdict.verdict,
				'reason': verdict.details.get('reason'),
				'why': verdict.details.get('why'),
				'cost': evaluation.cost,
			},
		),
	)
	return verdict.verdict


def aoi_key(aoi: dict | None) -> str | None:
	"""A stable short id of the AOI the run judged, part of the run's inputs."""
	if not aoi:
		return None
	return hashlib.sha256(json.dumps(aoi, sort_keys=True).encode()).hexdigest()[:16]


def _fetch_inputs(token: str, dataset_id: int):
	with use_client(token) as client:
		cogs = client.table(settings.cogs_table).select('*').eq('dataset_id', dataset_id).execute().data
		orthos = client.table(settings.orthos_table).select('*').eq('dataset_id', dataset_id).execute().data
		thumbnails = (
			client.table(settings.thumbnails_table).select('thumbnail_path').eq('dataset_id', dataset_id).execute().data
		)
		aois = (
			client.table(settings.aois_table)
			.select('geometry,is_whole_image,source,created_at')
			.eq('dataset_id', dataset_id)
			.execute()
			.data
		)
	if not cogs or not orthos:
		raise ValueError('dataset has no COG or ortho; run the ortho and cog stages first')
	thumbnail_path = thumbnails[0]['thumbnail_path'] if thumbnails else None
	return Cog(**cogs[0]), Ortho(**orthos[0]), thumbnail_path, select_aoi(aois)


def _local_thumbnail(thumbnail_path: str | None, temp_dir: Path, token: str, dataset_id: int) -> bytes | None:
	"""The stored thumbnail the website shows, or None when the dataset has none."""
	if not thumbnail_path:
		return None
	local = temp_dir / f'evaluation-source-{Path(thumbnail_path).name}'
	remote = f'{settings.STORAGE_SERVER_DATA_PATH}/{settings.THUMBNAIL_DIR}/{thumbnail_path}'
	pull_file_from_storage_server(remote, str(local), token, dataset_id)
	return local.read_bytes()
