"""Inference-only port of the research DOY model (train.py DOYModel).

logits(day) = seasonal_head(day | ortho patches, site facts)
            + s2_head(day | S2 weeks of the flight year, ortho, site)

Only the deployed configuration is supported: 16 x 10 cm patches, DINOv2
features, attention pooling, no phenology curve. The layer names match the
research checkpoints so the converted state dicts load strictly.
"""

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from safetensors.torch import load_file

from .circular import NBINS, wrapped_gaussian

# week-token columns (features.week_features): 17 S2 bands/indices, clear
# share + S2 flag, 12 match features + match flag
WK_RAW, WK_MATCH = slice(0, 17), slice(19, 32)
YEAR_COL = 6
MODEL_TYPES = ('s2', 'nos2')


class ViewEncoder(nn.Module):
	def __init__(self, emb_dim: int, D: int, feat_drop: float):
		super().__init__()
		self.emb = nn.Sequential(nn.LayerNorm(emb_dim), nn.Dropout(feat_drop), nn.Linear(emb_dim, D))
		self.scale_emb = nn.Parameter(torch.zeros(1, D))
		self.q = nn.Parameter(torch.zeros(1, 1, D))
		self.att = nn.MultiheadAttention(D, 4, batch_first=True)
		self.out = nn.Linear(D, D)

	def forward(self, emb: torch.Tensor, valid: torch.Tensor) -> torch.Tensor:
		tokens = self.emb(emb.float()) + self.scale_emb[0]
		allmiss = ~valid.any(1)
		mask = valid.clone()
		mask[allmiss, 0] = True  # avoid NaN; output zeroed below
		o, _ = self.att(self.q.expand(tokens.shape[0], -1, -1), tokens, tokens, key_padding_mask=~mask)
		return self.out(o[:, 0] * (~allmiss).float()[:, None])


class DOYModel(nn.Module):
	def __init__(self, cfg: dict, emb_dim: int, s2_dim: int, static_dim: int):
		super().__init__()
		assert cfg['p10'] > 0 and not cfg['p1m'] and not cfg['ov'], cfg
		assert cfg['feats'] == 'dino' and cfg['pool'] == 'attn' and not cfg['pheno'], cfg
		D = cfg['D']
		self.cfg = cfg
		self.views = ViewEncoder(emb_dim, D, cfg['feat_drop'])
		self.static = nn.Sequential(nn.Linear(static_dim, 64), nn.GELU(), nn.Linear(64, 64))
		keep = torch.ones(static_dim)
		if cfg.get('noyear'):
			keep[YEAR_COL] = 0
		self.register_buffer('static_keep', keep, persistent=False)
		self.trunk = nn.Sequential(nn.Linear(D + 64, 256), nn.GELU(), nn.Dropout(0.1), nn.Linear(256, 256), nn.GELU())
		ang = 2 * np.pi * (np.arange(NBINS) + 0.5) / NBINS
		four = np.concatenate([np.stack([np.sin(k * ang), np.cos(k * ang)], 1) for k in range(1, 5)], 1)
		self.register_buffer('four', torch.tensor(four, dtype=torch.float32))
		self.day_in = nn.Linear(8, 96)
		self.day_ctx = nn.Linear(256, 96)
		self.day_out = nn.Sequential(nn.GELU(), nn.Linear(96, 96), nn.GELU(), nn.Linear(96, 1))
		if cfg['s2']:
			self.wk_in = nn.Linear(s2_dim + 3, 128)
			self.wk_ctx = nn.Linear(256, 128)
			self.conv1 = nn.Conv1d(128, 128, 5, padding=2)
			self.conv2 = nn.Conv1d(128, 128, 5, padding=2)
			self.wk_out = nn.Linear(128, 1)
			self.log_bw = nn.Parameter(torch.tensor(np.log(4.0), dtype=torch.float32))
			wk_keep = torch.ones(s2_dim)
			if cfg['wk'] == 'raw':
				wk_keep[WK_MATCH] = 0
			elif cfg['wk'] == 'match':
				wk_keep[WK_RAW] = 0
			self.register_buffer('wk_keep', wk_keep)

	def forward(self, b: dict) -> torch.Tensor:
		z_s = self.static(b['static'] * self.static_keep)
		z_o = self.views(b['p10_emb'], b['p10_valid'])
		h = self.trunk(torch.cat([z_o, z_s], 1))
		B = h.shape[0]
		x = self.day_in(self.four[None].expand(B, -1, -1)) + self.day_ctx(h)[:, None]
		logits = self.day_out(x)[..., 0]
		if self.cfg['s2']:
			pos, m = b['s2pos'], b['s2m']
			ang = 2 * np.pi * pos / NBINS
			wk = torch.cat(
				[b['s2w'].float() * self.wk_keep, torch.sin(ang)[..., None], torch.cos(ang)[..., None], (pos / NBINS)[..., None]],
				-1,
			)
			t = F.gelu(self.wk_in(wk) + self.wk_ctx(h)[:, None]) * m[..., None]
			t = t.transpose(1, 2)
			t = F.gelu(self.conv1(t)) * m[:, None]
			t = F.gelu(self.conv2(t)) * m[:, None]
			s = self.wk_out(t.transpose(1, 2))[..., 0]
			days = torch.arange(NBINS, device=pos.device).float() + 0.5
			k = torch.exp(-0.5 * ((days[None, :, None] - pos[:, None, :]) / self.log_bw.exp()) ** 2)
			k = k * m[:, None, :].float()
			logits = logits + (k * s[:, None, :]).sum(-1) / (k.sum(-1) + 0.1)
		return logits


def calibrate(p: np.ndarray, T: float, s: float) -> np.ndarray:
	"""p_cal ∝ smooth_s(p ** (1/T)), s the width in bins of a wrapped Gaussian."""
	q = np.clip(p.astype(np.float64), 1e-12, None) ** (1.0 / T)
	q /= q.sum(-1, keepdims=True)
	if s > 0:
		k = wrapped_gaussian([-0.5], s)[0]
		q = np.real(np.fft.ifft(np.fft.fft(q, axis=-1) * np.fft.fft(k), axis=-1))
		q = np.clip(q, 1e-12, None)
		q /= q.sum(-1, keepdims=True)
	return q


@dataclass
class Ensemble:
	model_type: str
	nets: list[DOYModel]
	calibration: dict

	def calibration_for(self, biome_name: str | None) -> dict:
		by_biome = self.calibration.get('by_biome', {})
		c = by_biome.get(biome_name or '', self.calibration)
		return {'T': c['T'], 's': c['s'], 'biome': biome_name if biome_name in by_biome else None}


@dataclass
class DoyModelBundle:
	version: str
	manifest: dict
	ensembles: dict[str, Ensemble]
	backbone_path: Path
	backbone_name: str


def load_bundle(model_dir: Path, device: str) -> DoyModelBundle:
	model_dir = Path(model_dir)
	manifest = json.loads((model_dir / 'manifest.json').read_text())
	ensembles = {}
	for model_type in MODEL_TYPES:
		spec = manifest['models'][model_type]
		nets = []
		for seed in spec['seeds']:
			tensors = load_file(str(model_dir / seed['file']))
			state = {k[len('state.') :]: v for k, v in tensors.items() if k.startswith('state.')}
			net = DOYModel(seed['cfg'], seed['emb_dim'], seed['s2_dim'], seed['static_dim'])
			net.load_state_dict(state, strict=True)
			nets.append(net.to(device).eval())
		ensembles[model_type] = Ensemble(model_type, nets, spec['calibration'])
	return DoyModelBundle(
		version=manifest['version'],
		manifest=manifest,
		ensembles=ensembles,
		backbone_path=model_dir / manifest['backbone']['file'],
		backbone_name=manifest['backbone']['timm_name'],
	)


@torch.no_grad()
def predict_distribution(ensemble: Ensemble, inputs: dict, biome_name: str | None, device: str) -> tuple[np.ndarray, dict]:
	"""Calibrated (365,) distribution for one ortho; inputs from features.site_inputs."""
	b = {k: torch.as_tensor(v, device=device) for k, v in inputs.items()}
	acc = np.zeros(NBINS)
	for net in ensemble.nets:
		acc += F.softmax(net(b).double(), 1)[0].cpu().numpy()
	cal = ensemble.calibration_for(biome_name)
	return calibrate(acc / len(ensemble.nets), cal['T'], cal['s']), cal
