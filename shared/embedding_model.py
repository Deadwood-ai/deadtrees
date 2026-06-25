"""OpenCLIP ViT-H/14 model loading and encoding for open-vocabulary tile search.

Adapted from the standalone ``deadtrees-search-modular`` package. Both the
processor (image/patch embeddings) and the API (text-query embeddings) use this
module so the model id, weights, normalization and embedding dimension stay in
one place.

Heavy dependencies (``torch``/``open_clip``) are imported lazily inside the
functions so that importing :mod:`shared` from lightweight code paths (or in the
test suite without the ML stack installed) does not pull in torch.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Callable, List, Sequence

# OpenCLIP ViT-H/14 trained on LAION-2B. The pretrained tag is downloaded and
# cached by open_clip on first use (see ``open_clip.create_model_and_transforms``).
OPENCLIP_MODEL_NAME = 'ViT-H-14'
OPENCLIP_PRETRAINED = 'laion2b_s32b_b79k'

# Image and text embeddings produced by ViT-H/14 share this dimensionality. The
# pgvector column in v2_tile_embeddings must match exactly.
EMBEDDING_DIM = 1024

# Calibration: raw CLIP image<->text cosine sits in a narrow band (~0.15-0.32)
# and is not a probability. We turn it into one via a softmax of the query
# against a fixed bank of generic "background" prompts: a tile's probability is
# softmax(temperature * [sim_query, sim_bg_1, ...])[query]. Each tile stores its
# (query-independent) similarities to these prompts (bg_sims) so the ranking RPCs
# only need the query vector. Higher temperature = more contrast.
BACKGROUND_PROMPTS = [
	'a photo',
	'an aerial photograph',
	'the ground',
	'natural scenery',
	'a texture',
	'background scenery',
]
DEFAULT_TEMPERATURE = 50.0

_REPO_ROOT = Path(__file__).resolve().parent.parent

# Local checkpoint, provisioned exactly like the segmentation model weights
# (assets/models/<file>, bind-mounted at runtime, not committed). The processor
# and API run on different servers, so each provisions its own copy. When the
# file is present it is used directly (no network); otherwise the code falls back
# to downloading the pretrained tag and caching it (see _cache_dir below).
OPENCLIP_WEIGHTS_FILENAME = 'openclip_vith14_laion2b_s32b_b79k.safetensors'
_DEFAULT_WEIGHTS_PATH = _REPO_ROOT / 'assets' / 'models' / OPENCLIP_WEIGHTS_FILENAME

# Cache dir for the download fallback only. MUST be persistent: the processor
# runs as a cron-recreated container, so a default ~/.cache would force a fresh
# download every run. Override with OPENCLIP_CACHE_DIR.
_DEFAULT_CACHE_DIR = _REPO_ROOT / 'assets' / 'openclip_cache'


def _weights_path() -> Path:
	return Path(os.environ.get('OPENCLIP_WEIGHTS_PATH', _DEFAULT_WEIGHTS_PATH))


def _cache_dir() -> Path:
	cache_dir = Path(os.environ.get('OPENCLIP_CACHE_DIR', _DEFAULT_CACHE_DIR))
	cache_dir.mkdir(parents=True, exist_ok=True)
	# Point HuggingFace Hub (used by open_clip for downloads) at the same
	# persistent location so nothing falls back to ~/.cache.
	os.environ.setdefault('HF_HOME', str(cache_dir))
	os.environ.setdefault('HUGGINGFACE_HUB_CACHE', str(cache_dir))
	return cache_dir


@dataclass
class ModelBundle:
	model: Any
	preprocess: Callable
	tokenizer: Callable
	device: Any
	model_id: str


def load_openclip(device: str = 'cpu') -> ModelBundle:
	"""Load OpenCLIP ViT-H/14, downloading + caching the pretrained weights."""
	import open_clip
	import torch

	weights_path = _weights_path()
	if weights_path.exists():
		# Use the locally provisioned checkpoint (same model as the pretrained
		# tag, just resolved from disk) — no network access required.
		pretrained = str(weights_path)
		cache_dir = None
	else:
		# Fall back to downloading + caching the pretrained tag.
		pretrained = OPENCLIP_PRETRAINED
		cache_dir = str(_cache_dir())

	model, _, preprocess = open_clip.create_model_and_transforms(
		model_name=OPENCLIP_MODEL_NAME,
		pretrained=pretrained,
		device=torch.device(device),
		cache_dir=cache_dir,
	)
	tokenizer = open_clip.get_tokenizer(OPENCLIP_MODEL_NAME)
	model.to(device)
	model.eval()
	return ModelBundle(
		model=model,
		preprocess=preprocess,
		tokenizer=tokenizer,
		device=torch.device(device),
		model_id=f'{OPENCLIP_MODEL_NAME}/{OPENCLIP_PRETRAINED}',
	)


def encode_images(bundle: ModelBundle, images: Sequence) -> 'Any':
	"""L2-normalized image embeddings for a batch of PIL images."""
	import torch

	tensors = [bundle.preprocess(img).unsqueeze(0) for img in images]
	batch = torch.cat(tensors, dim=0).to(bundle.device)
	with torch.no_grad():
		feats = bundle.model.encode_image(batch)
		feats = feats / feats.norm(dim=-1, keepdim=True)
	return feats


def encode_texts(bundle: ModelBundle, texts: List[str]) -> 'Any':
	"""L2-normalized text embeddings for a list of query strings."""
	import torch

	tokens = bundle.tokenizer(texts)
	tokens = tokens.to(bundle.device)
	with torch.no_grad():
		feats = bundle.model.encode_text(tokens)
		feats = feats / feats.norm(dim=-1, keepdim=True)
	return feats


# --- Cached CPU text encoder (used by the API for query embeddings) -----------

_TEXT_BUNDLE: ModelBundle | None = None
_TEXT_BUNDLE_LOCK = Lock()


def get_text_bundle() -> ModelBundle:
	"""Return a process-wide, lazily-loaded CPU text encoder bundle.

	The query encoder runs on CPU inside the API process. The model is loaded
	once on first request and reused for the lifetime of the process.
	"""
	global _TEXT_BUNDLE
	if _TEXT_BUNDLE is None:
		with _TEXT_BUNDLE_LOCK:
			if _TEXT_BUNDLE is None:
				_TEXT_BUNDLE = load_openclip(device='cpu')
	return _TEXT_BUNDLE


def embed_text(text: str) -> List[float]:
	"""Encode a single query string into a plain python list of floats."""
	bundle = get_text_bundle()
	feats = encode_texts(bundle, [text])
	return feats.detach().cpu().float().numpy()[0].tolist()


# --- Background-prompt calibration --------------------------------------------

_BG_EMB = None
_BG_EMB_LOCK = Lock()


def background_embeddings(bundle: ModelBundle | None = None):
	"""L2-normalized embeddings of BACKGROUND_PROMPTS (cached, K x EMBEDDING_DIM)."""
	global _BG_EMB
	if _BG_EMB is None:
		with _BG_EMB_LOCK:
			if _BG_EMB is None:
				b = bundle or get_text_bundle()
				_BG_EMB = encode_texts(b, BACKGROUND_PROMPTS).detach().cpu().float().numpy()
	return _BG_EMB


def tile_background_sims(image_embeddings, bundle: ModelBundle | None = None):
	"""Cosine sims of each tile embedding to every background prompt.

	image_embeddings: (N, EMBEDDING_DIM) L2-normalized array.
	returns: (N, K) array (cosine == dot product for normalized vectors).
	"""
	import numpy as np

	bg = background_embeddings(bundle)
	emb = np.asarray(image_embeddings, dtype=np.float32)
	if emb.ndim == 1:
		emb = emb[None, :]
	return emb @ bg.T
