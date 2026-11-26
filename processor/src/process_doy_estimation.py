from datetime import datetime, timezone
from pathlib import Path

from shared.db import login, login_verified, use_client
from shared.logger import logger
from shared.logging import LogCategory, LogContext
from shared.models import Cog, Dataset, Ortho, QueueTask, StatusEnum
from shared.settings import settings
from shared.status import update_status

from .exceptions import AuthenticationError, DatasetError, ProcessingError
from .utils.stored_inputs import local_cog as _local_cog
from .utils.stored_inputs import select_aoi


def process_doy_estimation(task: QueueTask, token: str, temp_dir: Path):
	"""Estimate the acquisition day of year.

	Reads the dataset's COG (local from this run, else from storage), crops the
	Sentinel-2 block cube of the flight year where the Sentinel pipeline has it,
	runs the S2 or no-S2 model and stores the distribution in
	v2_acquisition_date_estimates, replacing the previous estimate. The audit's
	date check reads the estimate; this stage writes nothing else.
	"""
	import torch

	from .doy_estimation_v1.features import OrthoNotSampleable
	from .doy_estimation_v1.predict_doy import estimate_acquisition_date

	token, user = login_verified(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
	if not user:
		raise AuthenticationError('Invalid token')

	def ctx(extra=None):
		return LogContext(category=LogCategory.DOY, dataset_id=task.dataset_id, user_id=user.id, token=token, extra=extra)

	try:
		inputs = _fetch_inputs(token, task.dataset_id)
	except Exception as e:
		logger.error('Failed to fetch acquisition-date inputs', ctx({'error': str(e)}))
		raise DatasetError(f'Error fetching dataset: {e}', dataset_id=task.dataset_id, task_id=task.id)
	dataset, ortho, cog, aoi, biome_name = inputs

	update_status(token, dataset_id=task.dataset_id, current_status=StatusEnum.doy_estimation, is_doy_estimation_done=False)
	try:
		if not dataset.aquisition_year:
			# the model dates the flight within a given year; without one there is
			# nothing to estimate (the upload form requires the year)
			logger.warning('Dataset has no acquisition year; skipping date estimation', ctx())
			_clear(token, task.dataset_id)
		else:
			cog_path = _local_cog(cog, Path(temp_dir), token, task.dataset_id, ctx())
			b = ortho.bbox
			try:
				estimate = estimate_acquisition_date(
					cog_path=str(cog_path),
					dataset_id=task.dataset_id,
					lat=(b.bottom + b.top) / 2,
					lon=(b.left + b.right) / 2,
					year=dataset.aquisition_year,
					month=dataset.aquisition_month,
					day=dataset.aquisition_day,
					aoi_4326=aoi,
					bbox_4326=(b.left, b.bottom, b.right, b.top),
					biome_name=biome_name,
				)
			except OrthoNotSampleable as e:
				# like a missing year, an ortho the model cannot sample has no estimate;
				# the optional date estimate must not fail an otherwise processed dataset
				logger.warning(f'Ortho cannot be sampled ({e}); skipping date estimation', ctx())
				_clear(login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD), task.dataset_id)
			else:
				token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
				_store(token, task.dataset_id, dataset, estimate)
				a = estimate.assessment
				logger.info(
					'Acquisition-date estimation completed',
					ctx(
						{
							'model_type': estimate.model_type,
							's2_status': estimate.s2.status,
							'predicted_date': a.predicted_date.isoformat(),
							'is_mismatch': a.is_mismatch,
							'suggestion_reason': a.suggestion_reason,
						}
					),
				)
		if torch.cuda.is_available():
			torch.cuda.empty_cache()
		token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		update_status(token, dataset_id=task.dataset_id, current_status=StatusEnum.idle, is_doy_estimation_done=True)
	except Exception as e:
		if torch.cuda.is_available():
			torch.cuda.empty_cache()
		logger.error('Acquisition-date estimation failed', ctx({'error': str(e)}))
		raise ProcessingError(str(e), task_type='doy_estimation', task_id=task.id, dataset_id=task.dataset_id)


def _fetch_inputs(token: str, dataset_id: int):
	with use_client(token) as client:
		dataset = Dataset(**client.table(settings.datasets_table).select('*').eq('id', dataset_id).execute().data[0])
		ortho = Ortho(**client.table(settings.orthos_table).select('*').eq('dataset_id', dataset_id).execute().data[0])
		cogs = client.table(settings.cogs_table).select('*').eq('dataset_id', dataset_id).execute().data
		aois = (
			client.table(settings.aois_table)
			.select('geometry,is_whole_image,source,created_at')
			.eq('dataset_id', dataset_id)
			.execute()
			.data
		)
		meta = client.table(settings.metadata_table).select('metadata').eq('dataset_id', dataset_id).execute().data
	if not cogs:
		raise ValueError('dataset has no COG; run the cog stage first')
	if not ortho.bbox:
		raise ValueError('dataset has no bbox')
	biome = ((meta[0].get('metadata') or {}).get('biome') or {}) if meta else {}
	return dataset, ortho, Cog(**cogs[0]), select_aoi(aois), biome.get('biome_name')


def estimate_row(dataset_id: int, dataset: Dataset, estimate) -> dict:
	a = estimate.assessment
	return {
		'dataset_id': dataset_id,
		'model_version': estimate.model_version,
		'model_type': estimate.model_type,
		'probabilities': [round(float(x), 7) for x in estimate.probabilities],
		'flight_year': dataset.aquisition_year,
		'recorded_year': dataset.aquisition_year,
		'recorded_month': dataset.aquisition_month,
		'recorded_day': dataset.aquisition_day,
		'recorded_precision': a.recorded_precision,
		'predicted_date': a.predicted_date.isoformat(),
		'mode_date': a.mode_date.isoformat(),
		'hdi': a.hdi,
		'hdi80_days': a.hdi80_days,
		'n_modes': a.n_modes,
		'recorded_surprise': a.recorded_surprise,
		'recorded_offset_days': a.recorded_offset_days,
		'is_mismatch': a.is_mismatch,
		'suggested_date': a.suggested_date.isoformat() if a.suggested_date else None,
		'suggestion_reason': a.suggestion_reason,
		'recommend_accept': a.recommend_accept,
		'metadata': {
			'model_version': estimate.model_version,
			'model_type': estimate.model_type,
			's2': estimate.s2.as_dict(),
			'inputs': estimate.inputs,
			**a.details,
		},
		'updated_at': datetime.now(timezone.utc).isoformat(),
	}


def _clear(token: str, dataset_id: int) -> None:
	"""Remove an earlier estimate when a rerun produces none."""
	with use_client(token) as client:
		client.table(settings.acquisition_date_estimates_table).delete().eq('dataset_id', dataset_id).execute()


def _store(token: str, dataset_id: int, dataset: Dataset, estimate) -> None:
	with use_client(token) as client:
		client.table(settings.acquisition_date_estimates_table).upsert(
			estimate_row(dataset_id, dataset, estimate), on_conflict='dataset_id'
		).execute()
