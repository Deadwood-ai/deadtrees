from datetime import date, datetime, timezone
from pathlib import Path

from shared.asset_manifest import GEOREF_CHECK_TASK_TYPE
from shared.db import login, login_verified, use_client
from shared.logger import logger
from shared.logging import LogCategory, LogContext
from shared.models import Cog, Dataset, QueueTask, StatusEnum
from shared.settings import settings
from shared.status import update_status

from .exceptions import AuthenticationError, DatasetError, ProcessingError
from .utils.stored_inputs import local_cog as _local_cog
from .utils.stored_inputs import select_aoi

# the audit form field this stage prefills (dataset_audit_suggestions.field)
SUGGESTED_FIELD = 'is_georeferenced'


def process_georef_check(task: QueueTask, token: str, temp_dir: Path):
	"""Measure the georeferencing offset and prefill the georeferencing audit item.

	Matches the dataset's COG (inside its AOI) against Esri World Imagery, its
	dated Wayback captures and any keyed provider, and stores the per-reference
	evidence and the Good/Poor/uncertain call in v2_georef_checks. A Good or Poor
	call becomes the is_georeferenced audit suggestion; when it disagrees with a
	saved audit, the dataset appears in audit_review_queue (the Re-review tab).
	An uncertain call leaves no suggestion. Saved audits are never modified.
	"""
	import torch

	from .georef_check_v1.check import run_georef_check

	token, user = login_verified(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
	if not user:
		raise AuthenticationError('Invalid token')

	def ctx(extra=None):
		return LogContext(
			category=LogCategory.GEOREF, dataset_id=task.dataset_id, user_id=user.id, token=token, extra=extra
		)

	try:
		dataset, cog, aoi = _fetch_inputs(token, task.dataset_id)
	except Exception as e:
		logger.error('Failed to fetch georeferencing-check inputs', ctx({'error': str(e)}))
		raise DatasetError(f'Error fetching dataset: {e}', dataset_id=task.dataset_id, task_id=task.id)

	update_status(token, dataset_id=task.dataset_id, current_status=StatusEnum.georef_check, is_georef_check_done=False)
	try:
		cog_path = _local_cog(cog, Path(temp_dir), token, task.dataset_id, ctx())
		check = run_georef_check(str(cog_path), aoi, flight_date(dataset))
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		_store(token, task.dataset_id, check)
		a = check.assessment
		logger.info(
			'Georeferencing check completed',
			ctx(
				{
					'decision': a.decision,
					'evidence_level': a.evidence_level,
					'p90_m': a.p90_m,
					'references': [e.provider for e in check.references],
					'reference_errors': check.reference_errors,
					'seconds': check.seconds,
				}
			),
		)
		if torch.cuda.is_available():
			torch.cuda.empty_cache()
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		update_status(token, dataset_id=task.dataset_id, current_status=StatusEnum.idle, is_georef_check_done=True)
	except Exception as e:
		if torch.cuda.is_available():
			torch.cuda.empty_cache()
		logger.error('Georeferencing check failed', ctx({'error': str(e)}))
		raise ProcessingError(str(e), task_type='georef_check', task_id=task.id, dataset_id=task.dataset_id)


def flight_date(dataset: Dataset) -> date | None:
	"""The recorded flight date, mid-month or mid-year when less precise; it picks
	the Wayback capture closest in time."""
	if not dataset.aquisition_year:
		return None
	return date(
		dataset.aquisition_year,
		dataset.aquisition_month or 7,
		dataset.aquisition_day or (15 if dataset.aquisition_month else 1),
	)


def _fetch_inputs(token: str, dataset_id: int):
	with use_client(token) as client:
		dataset = Dataset(**client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute().data[0])
		cogs = client.table(settings.cogs_table).select('*').eq('dataset_id', dataset_id).execute().data
		aois = (
			client.table(settings.aois_table)
			.select('geometry,is_whole_image,source,created_at')
			.eq('dataset_id', dataset_id)
			.execute()
			.data
		)
	if not cogs:
		raise ValueError('dataset has no COG; run the cog stage first')
	return dataset, Cog(**cogs[0]), select_aoi(aois)


def check_row(dataset_id: int, check) -> dict:
	a = check.assessment
	return {
		'dataset_id': dataset_id,
		'model_version': check.details['model_version'],
		'rules_version': check.details['rules_version'],
		'decision': a.decision,
		'evidence_level': a.evidence_level,
		'reason': a.reason,
		'p90_m': a.p90_m,
		'evidence_groups': a.groups,
		'support': a.support,
		'edge_support': a.edge_support,
		'used_aoi': check.used_aoi,
		'reference_evidence': [e.as_dict() for e in check.references],
		'reference_errors': check.reference_errors,
		'metadata': {**check.details, 'grid': check.grid, 'seconds': check.seconds},
		'updated_at': datetime.now(timezone.utc).isoformat(),
	}


def suggestion_row(dataset_id: int, check) -> dict | None:
	"""Good/Poor prefill of the georeferencing audit item; none when uncertain."""
	a = check.assessment
	if a.decision not in ('good', 'poor'):
		return None
	deciding = [e for e in check.references if e.decides]
	return {
		'dataset_id': dataset_id,
		'field': SUGGESTED_FIELD,
		'value': a.decision == 'good',
		'source': GEOREF_CHECK_TASK_TYPE,
		'reason': a.evidence_level,  # strong / qualified / gross
		'details': {
			'p90_m': a.p90_m,
			'evidence_groups': a.groups,
			'references': [e.provider for e in deciding],
			'rules_version': check.details['rules_version'],
		},
		'updated_at': datetime.now(timezone.utc).isoformat(),
	}


def _store(token: str, dataset_id: int, check) -> None:
	suggestion = suggestion_row(dataset_id, check)
	with use_client(token) as client:
		client.table(settings.georef_checks_table).upsert(
			check_row(dataset_id, check), on_conflict='dataset_id'
		).execute()
		if suggestion:
			client.table(settings.audit_suggestions_table).upsert(suggestion, on_conflict='dataset_id,field').execute()
		else:
			# an uncertain rerun must not leave an older Good/Poor suggestion behind
			client.table(settings.audit_suggestions_table).delete().eq('dataset_id', dataset_id).eq(
				'source', GEOREF_CHECK_TASK_TYPE
			).execute()
