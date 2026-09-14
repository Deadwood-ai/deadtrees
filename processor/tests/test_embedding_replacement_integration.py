"""CPU-only processor stage against isolated PostgREST; model inference is stubbed."""

from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import numpy as np
import psycopg
import pytest
import rasterio
from rasterio.transform import from_origin

from processor.src import process_embeddings as stage
from processor.src.embedding_search import PatchEmbedding
from processor.src.exceptions import ProcessingError
from processor.src.utils.queue_runtime import delete_queue_task, owns_queue_task
from shared.db import login, use_client
from shared.models import QueueTask, TaskTypeEnum
from shared.settings import settings

pytestmark = pytest.mark.integration


def test_processor_replacement_and_same_worker_reclaim(test_processor_user, tmp_path, monkeypatch):
	assert urlparse(settings.SUPABASE_DB_URL).hostname in {'localhost', '127.0.0.1', 'host.docker.internal'}
	token = login(settings.PROCESSOR_USERNAME, settings.PROCESSOR_PASSWORD, use_cached_session=False)
	with use_client(token) as client:
		owner = client.auth.get_user(token).user.id
	with psycopg.connect(settings.SUPABASE_DB_URL, autocommit=True) as db:
		dataset = db.execute(
			"INSERT INTO public.v2_datasets(user_id,file_name,license,platform,data_access) VALUES(%s,'stage.tif','CC BY','drone','private') RETURNING id",
			(owner,),
		).fetchone()[0]
		try:
			db.execute('INSERT INTO public.v2_statuses(dataset_id) VALUES(%s)', (dataset,))
			db.execute(
				"INSERT INTO public.v2_orthos(dataset_id,ortho_file_name,ortho_file_size,version) VALUES(%s,'stage.tif',1,1)",
				(dataset,),
			)
			stamp = datetime.now(timezone.utc)
			task_id = db.execute(
				"INSERT INTO public.v2_queue(dataset_id,user_id,task_types,is_processing,claimed_by,claimed_at,priority) VALUES(%s,%s,ARRAY['geotiff','embeddings_v1'],true,'stage-test',%s,2) RETURNING id",
				(dataset, owner, stamp),
			).fetchone()[0]
			task = QueueTask(
				id=task_id,
				dataset_id=dataset,
				user_id=owner,
				task_types=[TaskTypeEnum.geotiff, TaskTypeEnum.embeddings_v1],
				priority=2,
				is_processing=True,
				claimed_by='stage-test',
				claimed_at=stamp,
				current_position=1,
			)
			with rasterio.open(
				tmp_path / 'stage.tif',
				'w',
				driver='GTiff',
				height=4,
				width=4,
				count=3,
				dtype='uint8',
				crs='EPSG:4326',
				transform=from_origin(8, 48, 0.0001, 0.0001),
			) as raster:
				raster.write(np.full((3, 4, 4), 100, dtype=np.uint8))
			patches = [
				PatchEmbedding(
					(8, 48, 8.001, 48.001),
					(i * 512, 0, (i + 1) * 512, 512),
					np.full(1024, 0.03125, dtype=np.float32),
					0,
				)
				for i in range(401)
			]
			monkeypatch.setattr(stage, 'load_openclip', lambda **kwargs: object())
			monkeypatch.setattr(stage, 'embed_orthophoto_tiles', lambda *args: patches)
			monkeypatch.setattr(stage, 'tile_background_sims', lambda matrix, **kwargs: np.zeros((len(matrix), 1)))
			stage.process_embeddings(task, token, tmp_path)
			assert db.execute(
				'SELECT is_embeddings_done FROM public.v2_statuses WHERE dataset_id=%s', (dataset,)
			).fetchone() == (True,)
			assert db.execute(
				'SELECT count(*) FROM public.v2_tile_embeddings WHERE dataset_id=%s', (dataset,)
			).fetchone() == (401,)
			# Claim timestamps also fence generic cleanup, even if the worker name is reused.
			new_stamp = stamp + timedelta(seconds=1)
			db.execute('UPDATE public.v2_queue SET claimed_at=%s WHERE id=%s', (new_stamp, task_id))
			assert not owns_queue_task(token, task)
			delete_queue_task(token, task)
			assert db.execute('SELECT count(*) FROM public.v2_queue WHERE id=%s', (task_id,)).fetchone() == (1,)
			task = task.model_copy(update={'claimed_at': new_stamp})
			assert owns_queue_task(token, task)

			def failed_inference(*args):
				raise RuntimeError('model unavailable')

			monkeypatch.setattr(stage, 'embed_orthophoto_tiles', failed_inference)
			with pytest.raises(ProcessingError, match='model unavailable'):
				stage.process_embeddings(task, token, tmp_path)
			assert db.execute(
				'SELECT is_embeddings_done FROM public.v2_statuses WHERE dataset_id=%s', (dataset,)
			).fetchone() == (False,)
			assert db.execute(
				'SELECT count(*) FROM public.v2_tile_embeddings WHERE dataset_id=%s', (dataset,)
			).fetchone() == (0,)
			# A real retry starts with a fresh claim and clears the failed attempt.
			new_stamp += timedelta(seconds=1)
			db.execute('UPDATE public.v2_queue SET claimed_at=%s WHERE id=%s', (new_stamp, task_id))
			db.execute("UPDATE public.v2_statuses SET current_status='idle' WHERE dataset_id=%s", (dataset,))
			task = task.model_copy(update={'claimed_at': new_stamp})
			monkeypatch.setattr(stage, 'embed_orthophoto_tiles', lambda *args: patches)
			stage.process_embeddings(task, token, tmp_path)
			assert db.execute(
				'SELECT is_embeddings_done FROM public.v2_statuses WHERE dataset_id=%s', (dataset,)
			).fetchone() == (True,)
			assert db.execute(
				'SELECT count(*) FROM public.v2_tile_embeddings WHERE dataset_id=%s', (dataset,)
			).fetchone() == (401,)

			def reclaim_during_inference(*args):
				db.execute(
					'UPDATE public.v2_queue SET claimed_at=%s WHERE id=%s',
					(new_stamp + timedelta(seconds=1), task_id),
				)
				return patches

			monkeypatch.setattr(stage, 'embed_orthophoto_tiles', reclaim_during_inference)
			with pytest.raises(ProcessingError, match='claim is no longer current'):
				stage.process_embeddings(task, token, tmp_path)
			assert db.execute(
				'SELECT is_embeddings_done FROM public.v2_statuses WHERE dataset_id=%s', (dataset,)
			).fetchone() == (False,)
			assert db.execute(
				'SELECT count(*) FROM public.v2_tile_embeddings WHERE dataset_id=%s', (dataset,)
			).fetchone() == (0,)
		finally:
			db.execute('DELETE FROM public.v2_datasets WHERE id=%s', (dataset,))
