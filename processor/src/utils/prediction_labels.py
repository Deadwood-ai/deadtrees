from typing import Any

from shared.db import login, use_client
from shared.labels import create_label_with_geometries, delete_unpublished_label
from shared.models import Label, LabelDataEnum, LabelPayloadData, LabelSourceEnum, LabelTypeEnum
from shared.settings import settings
from shared.retry import retry_on_transient_error


def _upload_and_publish(
	publication_rpc: str,
	dataset_id: int,
	user_id: str,
	label_data: LabelDataEnum,
	geometry: dict,
	model_config: dict[str, Any],
	properties: dict[str, Any] | None,
) -> Label:
	"""Upload a complete inactive label, then publish it atomically.

	The previous result stays live until the publication commits. A failed
	publication discards the unpublished upload.
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
		properties=properties,
	)
	label = create_label_with_geometries(payload, user_id, token, is_active=False)

	@retry_on_transient_error
	def publish() -> Label:
		with use_client(token) as client:
			response = client.rpc(
				publication_rpc,
				{
					'p_label_id': label.id,
					'p_expected_geometry_count': len(payload.geometry.coordinates),
				},
			).execute()
		return Label(**response.data)

	try:
		return publish()
	except Exception:
		with use_client(token) as client:
			delete_unpublished_label(client, label.id, token)
		raise


def replace_model_prediction_label(
	dataset_id: int,
	user_id: str,
	label_data: LabelDataEnum,
	geometry: dict,
	token: str,
	model_config: dict[str, Any],
	properties: dict[str, Any] | None = None,
) -> Label:
	"""Publish a new prediction and delete older labels of the same model in one transaction.

	Legacy unconfigured predictions are replaced too; other models' labels are kept.
	"""
	return _upload_and_publish(
		'replace_model_prediction_label', dataset_id, user_id, label_data, geometry, model_config, properties
	)


def create_versioned_model_prediction_label(
	dataset_id: int,
	user_id: str,
	label_data: LabelDataEnum,
	geometry: dict,
	token: str,
	model_config: dict[str, Any],
) -> Label:
	"""Create a new model-prediction label and deactivate older labels for the same model.

	This preserves legacy/other-model prediction labels and avoids deleting labels that
	may be referenced by geometry corrections.
	"""
	return _upload_and_publish(
		'publish_model_prediction_label', dataset_id, user_id, label_data, geometry, model_config, None
	)
