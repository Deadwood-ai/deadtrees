from typing import Any

from shared.db import login, use_client
from shared.labels import create_label_with_geometries, delete_model_prediction_labels
from shared.logging import LogCategory, LogContext
from shared.logger import logger
from shared.models import Label, LabelDataEnum, LabelPayloadData, LabelSourceEnum, LabelTypeEnum
from shared.settings import settings
from shared.retry import retry_on_transient_error


def replace_model_prediction_label(
	dataset_id: int,
	user_id: str,
	label_data: LabelDataEnum,
	geometry: dict,
	token: str,
	model_config: dict | None = None,
):
	"""Replace the existing model-prediction label for a dataset and label type."""
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

	deleted_count = delete_model_prediction_labels(
		dataset_id=dataset_id, label_data=label_data, token=token, model_config=model_config
	)
	if deleted_count > 0:
		logger.info(
			f'Deleted {deleted_count} existing prediction labels',
			LogContext(category=LogCategory.DEADWOOD, dataset_id=dataset_id, user_id=user_id, token=token),
		)

	payload = LabelPayloadData(
		dataset_id=dataset_id,
		label_source=LabelSourceEnum.model_prediction,
		label_type=LabelTypeEnum.semantic_segmentation,
		label_data=label_data,
		label_quality=3,
		model_metadata=model_config,
		geometry=geometry,
	)
	return create_label_with_geometries(payload, user_id, token)


def create_versioned_model_prediction_label(
	dataset_id: int,
	user_id: str,
	label_data: LabelDataEnum,
	geometry: dict,
	token: str,
	model_config: dict[str, Any],
):
	"""Create a new model-prediction label and deactivate older labels for the same model.

	This preserves legacy/other-model prediction labels and avoids deleting labels that
	may be referenced by geometry corrections.
	"""
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

	payload = LabelPayloadData(
		dataset_id=dataset_id,
		label_source=LabelSourceEnum.model_prediction,
		label_type=LabelTypeEnum.semantic_segmentation,
		label_data=label_data,
		label_quality=3,
		model_metadata=model_config,
		geometry=geometry,
	)
	label = create_label_with_geometries(payload, user_id, token, is_active=False)

	@retry_on_transient_error
	def publish() -> Label:
		with use_client(token) as client:
			response = client.rpc(
				'publish_model_prediction_label',
				{
					'p_label_id': label.id,
					'p_expected_geometry_count': len(payload.geometry.coordinates),
				},
			).execute()
		return Label(**response.data)

	return publish()
