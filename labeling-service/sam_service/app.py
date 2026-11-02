"""AI labeling service for the DeadTrees editors.

POST /segment   image + box and/or clicks -> one outline (pixel GeoJSON)
POST /concepts  image + text -> one outline per found instance
GET  /health    whether the model is loaded and how much GPU memory it holds

Runs on the processing server bound to localhost. The storage server reaches it
through a reverse SSH tunnel; its nginx only lets signed-in users through.
"""

import asyncio
import hashlib
import io
import json
import os
import time
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

from .masks import masks_to_geojson

IDLE_UNLOAD_S = float(os.environ.get('SAM_IDLE_UNLOAD_S', '900'))
GPU_FRACTION = float(os.environ.get('SAM_GPU_FRACTION', '0.35'))  # about 8 GB of a 24 GB card
ALLOWED_ORIGINS = os.environ.get('SAM_ALLOWED_ORIGIN_REGEX', r'https://(www\.)?deadtrees\.earth')
MAX_IMAGE_SIDE = 2048
MAX_TEXT = 80


class Runner:
	"""Serialises GPU work, loads the model on demand and unloads it when idle."""

	def __init__(self, models):
		self.models = models
		self.lock = asyncio.Lock()
		self.last_used = 0.0

	async def run(self, method: str, *args):
		async with self.lock:
			self.last_used = time.monotonic()
			if not self.models.loaded:
				await asyncio.to_thread(self.models.load)
			result = await asyncio.to_thread(getattr(self.models, method), *args)
			self.last_used = time.monotonic()
			return result

	async def unload_when_idle(self):
		while True:
			await asyncio.sleep(30)
			if self.models.loaded and time.monotonic() - self.last_used > IDLE_UNLOAD_S:
				async with self.lock:
					self.models.unload()


def create_app(models=None) -> FastAPI:
	if models is None:
		from .models import SamModels

		models = SamModels()
	runner = Runner(models)

	@asynccontextmanager
	async def lifespan(_app):
		import torch

		if torch.cuda.is_available():
			torch.cuda.set_per_process_memory_fraction(GPU_FRACTION)
		task = asyncio.create_task(runner.unload_when_idle())
		yield
		task.cancel()

	app = FastAPI(lifespan=lifespan)
	app.add_middleware(
		CORSMiddleware,
		allow_origin_regex=ALLOWED_ORIGINS,
		allow_methods=['GET', 'POST', 'OPTIONS'],
		allow_headers=['Authorization', 'Content-Type'],
		max_age=86400,
	)

	@app.get('/health')
	def health():
		idle = round(time.monotonic() - runner.last_used) if runner.last_used else None
		return {'loaded': models.loaded, 'idle_s': idle}

	@app.post('/segment')
	async def segment(
		image: Annotated[UploadFile, File()],
		bboxes: Annotated[str | None, Form()] = None,
		points: Annotated[str | None, Form()] = None,
		labels: Annotated[str | None, Form()] = None,
	):
		img, key = await _read_image(image)
		box = _json(bboxes)
		clicks = _json(points)
		if clicks and isinstance(clicks[0], (int, float)):
			clicks = [clicks]
		click_labels = _json(labels) if clicks else None
		if clicks and (not click_labels or len(click_labels) != len(clicks)):
			click_labels = [1] * len(clicks)
		if not box and not clicks:
			raise HTTPException(400, 'Send a box or at least one point')
		masks = await runner.run('segment', img, key, box, clicks, click_labels)
		return masks_to_geojson(masks)

	@app.post('/concepts')
	async def concepts(
		image: Annotated[UploadFile, File()],
		text: Annotated[str, Form()],
		threshold: Annotated[float, Form()] = 0.3,
	):
		img, _ = await _read_image(image)
		text = text.strip()[:MAX_TEXT]
		if not text:
			raise HTTPException(400, 'Empty text prompt')
		masks, scores = await runner.run('find', img, text, min(max(threshold, 0.05), 0.95))
		return masks_to_geojson(masks, scores)

	return app


async def _read_image(upload: UploadFile):
	data = await upload.read()
	try:
		image = Image.open(io.BytesIO(data)).convert('RGB')
	except Exception as e:
		raise HTTPException(400, 'Unreadable image') from e
	if max(image.size) > MAX_IMAGE_SIDE:
		raise HTTPException(413, f'Image larger than {MAX_IMAGE_SIDE} px')
	return image, hashlib.sha1(data).hexdigest()


def _json(value: str | None):
	if not value:
		return None
	try:
		return json.loads(value)
	except ValueError as e:
		raise HTTPException(400, 'Malformed prompt') from e
