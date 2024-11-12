import requests

from ..supabase import login, verify_token, use_client
from fastapi import HTTPException
from ..logger import logger
from ..settings import settings


def upload_to_supabase(dataset_id, label, aoi, label_type, label_source, label_quality):
	api_endpoint = settings.api_endpoint_datasets + str(dataset_id) + '/labels'

	token = login(settings.processor_username, settings.processor_password)
	user = verify_token(token)
	if not user:
		return HTTPException(status_code=401, detail='Invalid token')

	try:
		# print(f'Uploading to supabase: {api_endpoint}')
		with use_client(token) as client:
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
			f'Error: {e}, {response.text}, {response.status_code}, {response.headers}, {response.json()}, {api_endpoint}'
		)
		return None
