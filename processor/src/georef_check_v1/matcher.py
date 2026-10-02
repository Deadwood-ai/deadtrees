"""RoMa v2 matching of the drone image against one reference image."""

from __future__ import annotations

from dataclasses import replace
from functools import lru_cache

import numpy as np

from shared.asset_manifest import GEOREF_CHECK_MODEL_DIR_NAME
from shared.settings import ASSETS_DIR

SAMPLES = 3000  # matches drawn from RoMa's dense warp
MODEL_DIR = ASSETS_DIR / 'models' / GEOREF_CHECK_MODEL_DIR_NAME


@lru_cache(maxsize=1)
def load_matcher():
	from .romav2 import RoMaV2

	default = RoMaV2.Cfg()
	cfg = replace(default, descriptor=replace(default.descriptor, repo_dir=str(MODEL_DIR / 'dinov3')))
	return RoMaV2(cfg, weights_path=str(MODEL_DIR / 'romav2.safetensors'))


def match(source: np.ndarray, reference: np.ndarray, samples: int = SAMPLES):
	"""Matched pixel positions in source and reference, and RoMa's confidence."""
	import torch
	from PIL import Image

	model = load_matcher()
	torch.manual_seed(0)
	with torch.inference_mode():
		warp = model.match(Image.fromarray(source), Image.fromarray(reference))
		matches, confidence, _, _ = model.sample(warp, samples)
		h, w = source.shape[:2]
		a, b = model.to_pixel_coordinates(matches, h, w, h, w)
	return a.cpu().numpy(), b.cpu().numpy(), confidence.cpu().numpy().reshape(-1)
