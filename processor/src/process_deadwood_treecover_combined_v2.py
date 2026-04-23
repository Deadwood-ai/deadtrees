from pathlib import Path

from shared.db import use_client, login, login_verified
from shared.settings import settings
from shared.models import StatusEnum, Ortho, QueueTask
from shared.logger import logger
from shared.status import update_status
from shared.logging import LogContext, LogCategory

from .utils.local_ortho import ensure_local_ortho
from .deadwood_treecover_combined_v2.predict_combined import predict_combined
from .exceptions import AuthenticationError, DatasetError, ProcessingError


def process_deadwood_treecover_combined_v2(task: QueueTask, token: str, temp_dir: Path):
    import torch

    token, user = login_verified(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
    if not user:
        logger.error(
            'Invalid processor token',
            LogContext(category=LogCategory.DEADWOOD, dataset_id=task.dataset_id, user_id=task.user_id, token=token),
        )
        raise AuthenticationError('Invalid token')

    try:
        with use_client(token) as client:
            response = client.table(settings.orthos_table).select('*').eq('dataset_id', task.dataset_id).execute()
            ortho = Ortho(**response.data[0])
    except Exception as e:
        logger.error(
            'Failed to fetch ortho data',
            LogContext(
                category=LogCategory.DEADWOOD,
                dataset_id=task.dataset_id,
                user_id=user.id,
                token=token,
                extra={'error': str(e)},
            ),
        )
        raise DatasetError(f'Error fetching dataset: {e}')

    update_status(token, dataset_id=ortho.dataset_id, current_status=StatusEnum.deadwood_segmentation)
    logger.info(
        'Starting combined deadwood+treecover segmentation',
        LogContext(category=LogCategory.DEADWOOD, dataset_id=task.dataset_id, user_id=user.id, token=token),
    )

    file_path = Path(temp_dir) / ortho.ortho_file_name
    ensure_local_ortho(
        local_path=file_path,
        ortho_file_name=ortho.ortho_file_name,
        token=token,
        dataset_id=ortho.dataset_id,
        log_context=LogContext(
            category=LogCategory.DEADWOOD,
            dataset_id=task.dataset_id,
            user_id=user.id,
            token=token,
            extra={'file_path': str(file_path)},
        ),
    )

    try:
        logger.info(
            'Running combined prediction',
            LogContext(
                category=LogCategory.DEADWOOD,
                dataset_id=task.dataset_id,
                user_id=user.id,
                token=token,
                extra={'file_path': str(file_path)},
            ),
        )
        predict_combined(task.dataset_id, file_path, user.id, token)

        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
        update_status(
            token,
            dataset_id=ortho.dataset_id,
            current_status=StatusEnum.idle,
            is_deadwood_done=True,
            is_forest_cover_done=True,
        )
        logger.info(
            'Combined segmentation completed successfully',
            LogContext(category=LogCategory.DEADWOOD, dataset_id=task.dataset_id, user_id=user.id, token=token),
        )

    except Exception as e:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        logger.error(
            'Combined segmentation failed',
            LogContext(
                category=LogCategory.DEADWOOD,
                dataset_id=ortho.dataset_id,
                user_id=user.id,
                token=token,
                extra={'error': str(e)},
            ),
        )
        token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
        update_status(token, dataset_id=ortho.dataset_id, has_error=True, error_message=str(e))
        raise ProcessingError(
            str(e), task_type='deadwood_treecover_combined_segmentation', task_id=task.id, dataset_id=ortho.dataset_id
        )
