"""Duplicate-upload rule for Python callers (API finalisation and the CLI).

The rule itself is the database function `find_duplicate_upload`; see
supabase/migrations/20261006140000_duplicate_upload_detection.sql.
"""

from pathlib import Path
from typing import Optional

from shared.db import use_client
from shared.hash import get_file_identifier

DUPLICATE_UPLOAD_CODE = 'DUPLICATE_UPLOAD'
CONTACT_EMAIL = 'info@deadtrees.earth'


class DuplicateUploadError(Exception):
	"""The file is already on the platform. `detail` is the API's HTTP 409 body."""

	def __init__(self, existing_dataset_id: Optional[int]):
		if existing_dataset_id is None:
			found = 'This file has already been uploaded to deadtrees.earth.'
		else:
			found = (
				f'This file is already on deadtrees.earth as dataset {existing_dataset_id} '
				f'(https://deadtrees.earth/dataset/{existing_dataset_id}).'
			)
		message = (
			f'{found} If that dataset failed processing, contact {CONTACT_EMAIL} and we will rerun it. '
			f'If you believe this is a different file, contact {CONTACT_EMAIL} as well.'
		)
		super().__init__(message)
		self.detail = {
			'code': DUPLICATE_UPLOAD_CODE,
			'message': message,
			'existing_dataset_id': existing_dataset_id,
		}


def reject_duplicate_upload(file_path: Path, token: str) -> None:
	"""Raise DuplicateUploadError when a non-archived dataset already holds this file.

	`existing_dataset_id` is None when the caller may not see that dataset.
	"""
	with use_client(token) as client:
		response = client.rpc('find_duplicate_upload', {'p_fingerprint': get_file_identifier(file_path)}).execute()
	if response.data:
		raise DuplicateUploadError(response.data[0]['dataset_id'])
