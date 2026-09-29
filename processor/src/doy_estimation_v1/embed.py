"""Frozen DINOv2 ViT-B/14 (registers) embeddings of the 10 cm patches.

[CLS token, mean patch token] per 224 px patch, as the research embed.py
computed them. Weights come from the model asset directory, never from the
network.
"""

from pathlib import Path

import numpy as np
import torch
from safetensors.torch import load_file


def load_backbone(weights_path: Path, timm_name: str, device: str):
	import timm

	model = timm.create_model(timm_name, pretrained=False, num_classes=0, img_size=224)
	model.load_state_dict(load_file(str(weights_path)), strict=True)
	# training ran the backbone in fp16 on the GPU; CPU fp16 is slow and not
	# needed for a batch of 16, so CPU inference stays fp32
	dtype = torch.float16 if device.startswith('cuda') else torch.float32
	model = model.to(device).eval().to(dtype)
	cfg = model.pretrained_cfg
	mean = torch.tensor(cfg['mean'], device=device).view(1, 3, 1, 1)
	std = torch.tensor(cfg['std'], device=device).view(1, 3, 1, 1)
	npre = model.num_prefix_tokens

	@torch.no_grad()
	def embed(patches: np.ndarray) -> np.ndarray:
		"""(N, 224, 224, 3) uint8 -> (N, 1536) float16."""
		x = torch.from_numpy(patches).to(device).permute(0, 3, 1, 2).float() / 255
		x = ((x - mean) / std).to(dtype)
		tok = model.forward_features(x)
		e = torch.cat([tok[:, 0], tok[:, npre:].mean(1)], 1)
		return e.float().cpu().numpy().astype(np.float16)

	return embed
