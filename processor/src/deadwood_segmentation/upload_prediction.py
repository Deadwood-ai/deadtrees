import requests

from shared.db import login, verify_token, use_client
from shared.logger import logger
from shared.settings import settings
from ..exceptions import AuthenticationError
from shared.logging import LogContext, LogCategory


def upload_to_supabase(dataset_id, label, aoi, label_type, label_source, label_quality):
	api_endpoint = settings.API_ENTPOINT_DATASETS + str(dataset_id) + '/labels'

	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD)
	user = verify_token(token)
	if not user:
		raise AuthenticationError('Invalid token')

	try:
		with use_client(token):
			headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'}
			data = {
				'dataset_id': dataset_id,
				'label': label,
				'aoi': aoi,
				'label_type': label_type,
				'label_source': label_source,
				'label_quality': label_quality,
			}
			# print(f'Data: {data}')
			response = requests.post(api_endpoint, headers=headers, json=data)
			return response
	except Exception as e:
		logger.error(
			f'Error uploading prediction: {e}',
			LogContext(category=LogCategory.DEADWOOD, dataset_id=dataset_id, user_id=user.id, token=token),
		)
		return None
