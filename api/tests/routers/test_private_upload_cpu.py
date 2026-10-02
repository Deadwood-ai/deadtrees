"""Ordinary private upload through real CPU imagery stages, with only SSH replaced locally.

Run in the API test container with processor source mounted/copied at /app/processor.
No GPU, external processor, or production storage is used.
"""

import importlib
import shutil
import uuid
from pathlib import Path

import requests
from fastapi.testclient import TestClient
from api.src.server import app
from shared.db import use_client, use_service_client
from shared.models import QueueTask
from shared.settings import settings

client = TestClient(app)


def test_ordinary_private_upload_cpu_delivery(access_accounts, tmp_path, monkeypatch):
	import numpy as np
	import rasterio
	from rasterio.transform import from_origin

	import shared.db as database

	# Processor login is process-global; isolate it from contributor test sessions.
	monkeypatch.setattr(database, '_cached_sessions', {})
	owner = access_accounts['owner']
	with use_service_client() as db:
		assert not db.table('privileged_users').select('user_id').eq('user_id', owner['id']).execute().data
	image = tmp_path / 'private-cpu.tif'
	with rasterio.open(
		image,
		'w',
		driver='GTiff',
		width=128,
		height=128,
		count=3,
		dtype='uint8',
		crs='EPSG:32632',
		transform=from_origin(410000, 5315000, 1, 1),
	) as dst:
		dst.write(np.tile(np.arange(128, dtype=np.uint8), (3, 128, 1)))
	response = client.post(
		'/datasets/chunk',
		files={'file': ('private-cpu.tif', image.read_bytes(), 'image/tiff')},
		data={
			'chunk_index': '0',
			'chunks_total': '1',
			'upload_id': str(uuid.uuid4()),
			'license': 'CC BY',
			'platform': 'drone',
			'authors': ['Private CPU test'],
			'data_access': 'private',
			'upload_type': 'geotiff',
		},
		headers={'Authorization': f"Bearer {owner['token']}"},
	)
	assert response.status_code == 200, response.text
	dataset_id = response.json()['id']
	archive = settings.archive_path / f'{dataset_id}_ortho.tif'
	outputs = []
	try:
		assert archive.is_file()
		with use_client(owner['token']) as db:
			assert (
				db.table(settings.datasets_table)
				.select('data_access')
				.eq('id', dataset_id)
				.single()
				.execute()
				.data['data_access']
				== 'private'
			)
		# Geotiff standardization is outside this focused imagery contract; use the
		# already standardized RGB upload as the real COG/thumbnail stage input.
		with use_service_client() as db:
			db.table(settings.orthos_table).insert(
				{
					'dataset_id': dataset_id,
					'ortho_file_name': archive.name,
					'version': 1,
					'ortho_file_size': 1,
					'ortho_upload_runtime': 0,
				}
			).execute()
		shutil.copyfile(archive, tmp_path / archive.name)
		monkeypatch.setattr(settings, 'STORAGE_SERVER_DATA_PATH', str(settings.base_path))

		def local_transport(source, target, token, dataset_id):
			target = Path(target)
			target.parent.mkdir(parents=True, exist_ok=True)
			shutil.copyfile(source, target)
			outputs.append(target)

		task = QueueTask(
			id=0,
			dataset_id=dataset_id,
			user_id=owner['id'],
			priority=2,
			is_processing=True,
			current_position=0,
			task_types=['cog', 'thumbnail'],
		)
		for stage in ['cog', 'thumbnail']:
			module = importlib.import_module(f'processor.src.process_{stage}')
			monkeypatch.setattr(module, 'push_file_to_storage_server', local_transport)
			getattr(module, f'process_{stage}')(task, tmp_path)
		response = client.post(
			'/api/v1/datasets/files/tickets',
			json={'dataset_ids': [dataset_id]},
			headers={'Authorization': f"Bearer {owner['token']}"},
		)
		urls = response.json()['files'][str(dataset_id)]
		for kind, directory in [('cog', 'cogs'), ('thumbnail', 'thumbnails')]:
			url = urls[f'{kind}_url']
			assert requests.get(f'http://nginx/api/v1{url}', timeout=10).status_code == 200
			output = next(path for path in outputs if path.parent.parent.name == directory)
			assert (
				requests.get(f'http://nginx/{directory}/v1/{output.parent.name}/{output.name}', timeout=10).status_code
				== 403
			)
	finally:
		archive.unlink(missing_ok=True)
		for output in outputs:
			shutil.rmtree(output.parent)
		with use_service_client() as db:
			db.table(settings.datasets_table).delete().eq('id', dataset_id).execute()
