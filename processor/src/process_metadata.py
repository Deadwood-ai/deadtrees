from pathlib import Path
import time
from typing import Dict, Any

from shared.db import use_client, login, verify_token
from shared.status import update_status
from shared.settings import settings
from shared.models import StatusEnum, QueueTask, MetadataType, DatasetMetadata, AdminBoundariesMetadata, Ortho
from shared.logger import logger
from .exceptions import AuthenticationError, DatasetError, ProcessingError
from .utils.admin_levels import get_admin_tags
from shared.logging import LogContext, LogCategory


def process_metadata(task: QueueTask, temp_dir: Path):
	"""Process and store metadata for a dataset"""
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)

	user = verify_token(token)
	if not user:
		logger.error(
			'Invalid processor token',
			LogContext(category=LogCategory.AUTH, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
		)
		raise AuthenticationError('Invalid processor token', token=token, task_id=task.id)

	try:
		# Get orthophoto
		with use_client(token) as client:
			response = client.table(settings.orthos_table).select('*').eq('dataset_id', task.dataset_id).execute()
			ortho = Ortho(**response.data[0])

		update_status(token, task.dataset_id, current_status=StatusEnum.metadata_processing)

		# Process admin boundaries metadata
		t1 = time.time()
		if not ortho.bbox:
			logger.error(
				'No bbox available for dataset',
				LogContext(
					category=LogCategory.METADATA,
					dataset_id=task.dataset_id,
					user_id=task.user_id,
					token=token,
				),
			)
			raise DatasetError('No bbox available for dataset', dataset_id=task.dataset_id)

		bbox_centroid = (
			(ortho.bbox.left + ortho.bbox.right) / 2,  # longitude
			(ortho.bbox.bottom + ortho.bbox.top) / 2,  # latitude
		)

		logger.info(
			'Processing admin boundaries metadata',
			LogContext(
				category=LogCategory.METADATA,
				dataset_id=task.dataset_id,
				user_id=task.user_id,
				token=token,
				extra={'bbox_centroid': bbox_centroid},
			),
		)

		admin_levels = get_admin_tags(bbox_centroid)
		runtime = time.time() - t1

		admin_metadata = AdminBoundariesMetadata(
			admin_level_1=admin_levels[0], admin_level_2=admin_levels[1], admin_level_3=admin_levels[2]
		)

		# Create metadata entry
		metadata = DatasetMetadata(
			dataset_id=task.dataset_id,
			metadata={MetadataType.GADM: admin_metadata.model_dump()},
			version=1,
			processing_runtime=runtime,
		)
		update_status(token, task.dataset_id, current_status=StatusEnum.idle, is_metadata_done=True)
		# Save to database, excluding created_at to use DB default
		logger.info(
			'Saving metadata to database',
			LogContext(
				category=LogCategory.METADATA,
				dataset_id=task.dataset_id,
				user_id=task.user_id,
				token=token,
				extra={'runtime': runtime},
			),
		)

		with use_client(token) as client:
			client.table(settings.metadata_table).upsert(
				metadata.model_dump(exclude={'created_at'}), on_conflict='dataset_id'
			).execute()

		logger.info(
			'Processed metadata successfully',
			LogContext(
				category=LogCategory.METADATA,
				dataset_id=task.dataset_id,
				user_id=task.user_id,
				token=token,
				extra={'admin_levels': admin_levels, 'runtime': runtime},
			),
		)

	except Exception as e:
		logger.error(
			f'Metadata processing failed: {str(e)}',
			LogContext(
				category=LogCategory.METADATA,
				dataset_id=task.dataset_id,
				user_id=task.user_id,
				token=token,
				extra={'error': str(e)},
			),
		)
		update_status(token, task.dataset_id, has_error=True, error_message=str(e))
		raise ProcessingError(str(e), task_type='metadata', task_id=task.id, dataset_id=task.dataset_id)

	# Update final status
	update_status(token, task.dataset_id, current_status=StatusEnum.idle, is_metadata_done=True)
