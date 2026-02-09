"""
Dataset notification logic.

Looks up the user's email from the dataset and sends the appropriate
notification (failure or completion).
"""

import logging
from typing import Optional

from supabase import create_client

from shared.settings import settings
from .email import send_email
from .templates import dataset_failed_email, dataset_completed_email

logger = logging.getLogger(__name__)


def _get_user_email_for_dataset(dataset_id: int) -> Optional[str]:
	"""
	Look up the owner's email for a given dataset.
	Uses service role key to access auth.users.
	"""
	key = settings.SUPABASE_SERVICE_ROLE_KEY or settings.SUPABASE_KEY
	client = create_client(settings.SUPABASE_URL, key)

	# Get user_id from dataset
	response = client.table(settings.datasets_table).select('user_id').eq('id', dataset_id).single().execute()
	if not response.data:
		logger.warning(f"Dataset {dataset_id} not found")
		return None

	user_id = response.data.get('user_id')
	if not user_id:
		logger.warning(f"Dataset {dataset_id} has no user_id")
		return None

	# Get email from auth.users
	try:
		user_response = client.auth.admin.get_user_by_id(user_id)
		if user_response and user_response.user:
			return user_response.user.email
	except Exception as e:
		logger.error(f"Failed to get user email for user_id {user_id}: {e}")

	return None


def _get_dataset_file_name(dataset_id: int) -> str:
	"""Look up the file name for a dataset."""
	key = settings.SUPABASE_SERVICE_ROLE_KEY or settings.SUPABASE_KEY
	client = create_client(settings.SUPABASE_URL, key)

	response = client.table(settings.datasets_table).select('file_name').eq('id', dataset_id).single().execute()
	if response.data:
		return response.data.get('file_name', f'dataset_{dataset_id}')
	return f'dataset_{dataset_id}'


def notify_dataset_failed(
	dataset_id: int,
	error_message: str,
	to_email: Optional[str] = None,
	file_name: Optional[str] = None,
) -> dict:
	"""
	Send a failure notification email for a dataset.

	Args:
		dataset_id: The dataset ID.
		error_message: The error message from processing.
		to_email: Override recipient (for testing). If None, looks up the dataset owner.
		file_name: Override file name. If None, looks up from DB.

	Returns:
		dict with 'success' (bool) and details.
	"""
	if not to_email:
		to_email = _get_user_email_for_dataset(dataset_id)
	if not to_email:
		return {"success": False, "error": f"No email found for dataset {dataset_id}"}

	if not file_name:
		file_name = _get_dataset_file_name(dataset_id)

	subject, html_body = dataset_failed_email(dataset_id, file_name, error_message)
	return send_email(to_email, subject, html_body)


def notify_dataset_completed(
	dataset_id: int,
	to_email: Optional[str] = None,
	file_name: Optional[str] = None,
) -> dict:
	"""
	Send a completion notification email for a dataset.

	Args:
		dataset_id: The dataset ID.
		to_email: Override recipient (for testing). If None, looks up the dataset owner.
		file_name: Override file name. If None, looks up from DB.

	Returns:
		dict with 'success' (bool) and details.
	"""
	if not to_email:
		to_email = _get_user_email_for_dataset(dataset_id)
	if not to_email:
		return {"success": False, "error": f"No email found for dataset {dataset_id}"}

	if not file_name:
		file_name = _get_dataset_file_name(dataset_id)

	subject, html_body = dataset_completed_email(dataset_id, file_name)
	return send_email(to_email, subject, html_body)
