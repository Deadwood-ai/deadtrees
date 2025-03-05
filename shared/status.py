from typing import Optional
from .models import Status, StatusEnum
from .db import use_client
from .settings import settings
from .logger import logger
from shared.logging import LogContext, LogCategory


def update_status(
	token: str,
	dataset_id: int,
	current_status: Optional[StatusEnum] = None,
	is_upload_done: Optional[bool] = None,
	is_ortho_done: Optional[bool] = None,
	is_cog_done: Optional[bool] = None,
	is_thumbnail_done: Optional[bool] = None,
	is_deadwood_done: Optional[bool] = None,
	is_forest_cover_done: Optional[bool] = None,
	is_metadata_done: Optional[bool] = None,
	is_audited: Optional[bool] = None,
	has_error: Optional[bool] = None,
	error_message: Optional[str] = None,
) -> None:
	"""Update the status fields of a dataset in the statuses table.
	Only provided fields will be updated.

	Args:
	    token (str): Supabase client session token
	    dataset_id (int): Unique id of the dataset
	    current_status (StatusEnum, optional): Current processing status
	    is_upload_done (bool, optional): Upload completion status
	    is_ortho_done (bool, optional): Ortho processing completion status
	    is_cog_done (bool, optional): COG processing completion status
	    is_thumbnail_done (bool, optional): Thumbnail generation completion status
	    is_deadwood_done (bool, optional): Deadwood segmentation completion status
	    is_forest_cover_done (bool, optional): Forest cover completion status
	    is_metadata_done (bool, optional): Metadata processing completion status
	    is_audited (bool, optional): Audit completion status
	    has_error (bool, optional): Error status flag
	    error_message (str, optional): Error message if any
	"""
	try:
		update_data = {}
		if current_status is not None:
			update_data['current_status'] = current_status
		if is_upload_done is not None:
			update_data['is_upload_done'] = is_upload_done
		if is_ortho_done is not None:
			update_data['is_ortho_done'] = is_ortho_done
		if is_cog_done is not None:
			update_data['is_cog_done'] = is_cog_done
		if is_thumbnail_done is not None:
			update_data['is_thumbnail_done'] = is_thumbnail_done
		if is_deadwood_done is not None:
			update_data['is_deadwood_done'] = is_deadwood_done
		if is_forest_cover_done is not None:
			update_data['is_forest_cover_done'] = is_forest_cover_done
		if is_metadata_done is not None:
			update_data['is_metadata_done'] = is_metadata_done
		if is_audited is not None:
			update_data['is_audited'] = is_audited
		if has_error is not None:
			update_data['has_error'] = has_error
		if error_message is not None:
			update_data['error_message'] = error_message

		if update_data:
			with use_client(token) as client:
				# First check if status exists
				result = client.table(settings.statuses_table).select('id').eq('dataset_id', dataset_id).execute()

				if not result.data:
					# Create new status row if it doesn't exist
					client.table(settings.statuses_table).insert({'dataset_id': dataset_id, **update_data}).execute()
				else:
					# Update existing status
					client.table(settings.statuses_table).update(update_data).eq('dataset_id', dataset_id).execute()

	except Exception as e:
		logger.error(
			f'Error updating status: {e}', LogContext(category=LogCategory.ERROR, dataset_id=dataset_id, token=token)
		)
		raise
