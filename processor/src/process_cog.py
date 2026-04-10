from pathlib import Path
import time
import uuid

from shared.db import use_client, login, login_verified
from shared.settings import settings
from shared.models import StatusEnum, QueueTask, Cog, Ortho
from shared.logger import logger
from .cog.cog import calculate_cog
from .utils.ssh import push_file_to_storage_server
from .utils.local_ortho import ensure_local_ortho
from .exceptions import AuthenticationError, DatasetError, ProcessingError
from shared.status import update_status
from shared.logging import LogContext, LogCategory


def process_cog(task: QueueTask, temp_dir: Path):
	# login with the processor
	token, user = login_verified(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
	if not user:
		raise AuthenticationError('Invalid processor token', token=token, task_id=task.id)

	# Load dataset
	try:
		with use_client(token) as client:
			response = client.table(settings.orthos_table).select('*').eq('dataset_id', task.dataset_id).execute()
			ortho = Ortho(**response.data[0])
	except Exception as e:
		raise DatasetError(f'Failed to fetch dataset: {str(e)}', dataset_id=task.dataset_id, task_id=task.id)

	# Update status to processing
	update_status(token, dataset_id=ortho.dataset_id, current_status=StatusEnum.cog_processing)

	try:
		# Setup paths
		input_path = Path(temp_dir) / ortho.ortho_file_name

		# Prefer the standardized local ortho from the current pipeline run.
		ensure_local_ortho(
			local_path=input_path,
			ortho_file_name=ortho.ortho_file_name,
			token=token,
			dataset_id=task.dataset_id,
			log_context=LogContext(
				category=LogCategory.COG,
				dataset_id=task.dataset_id,
				user_id=user.id,
				token=token,
			),
		)

		# Get options and setup output paths
		file_name = f'{ortho.dataset_id}_cog.tif'
		output_path = Path(temp_dir) / file_name

		# Generate UUID for secure path (makes URL iteration impossible)
		secure_token = str(uuid.uuid4())

		# Generate COG
		t1 = time.time()
		info = calculate_cog(
			str(input_path),
			str(output_path),
			token=token,
		)
		logger.info(f'COG created for dataset {ortho.dataset_id}: {info}', extra={'token': token})

		# Push generated COG to UUID-prefixed path
		storage_server_cog_path = f'{settings.STORAGE_SERVER_DATA_PATH}/cogs/{secure_token}/{file_name}'
		push_file_to_storage_server(str(output_path), storage_server_cog_path, token, task.dataset_id)
		t2 = time.time()

		# Prepare metadata (cog_path includes UUID prefix for security)
		meta = dict(
			dataset_id=ortho.dataset_id,
			cog_file_size=max(1, int((output_path.stat().st_size / 1024 / 1024))),  # in MB
			cog_file_name=file_name,
			cog_path=f'{secure_token}/{file_name}',  # UUID-prefixed path for security
			version=1,
			cog_info=info.model_dump(),
			cog_processing_runtime=t2 - t1,
		)
		cog = Cog(**meta)

	except Exception as e:
		# Update status with error
		update_status(token, dataset_id=ortho.dataset_id, has_error=True, error_message=str(e))
		raise ProcessingError(str(e), task_type='cog', task_id=task.id, dataset_id=ortho.dataset_id)

	# Save metadata to database
	try:
		# Refresh token before database operation
		token, user = login_verified(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
		if not user:
			raise AuthenticationError('Token refresh failed', token=token, task_id=task.id)

		with use_client(token) as client:
			send_data = {k: v for k, v in cog.model_dump().items() if v is not None}
			client.table(settings.cogs_table).upsert(send_data, on_conflict='dataset_id').execute()

		# Update final status
		update_status(token, dataset_id=ortho.dataset_id, current_status=StatusEnum.idle, is_cog_done=True)

	except AuthenticationError:
		raise
	except Exception as e:
		update_status(
			token, dataset_id=ortho.dataset_id, has_error=True, error_message=f'Failed to save COG metadata: {str(e)}'
		)
		raise DatasetError(f'Failed to save COG metadata: {str(e)}', dataset_id=ortho.dataset_id, task_id=task.id)

	logger.info(
		f'Finished creating new COG for dataset {ortho.dataset_id}.',
		extra={'token': token},
	)
