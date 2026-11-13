#!/usr/bin/env python3
"""Convert a DOY-estimation deploy package into the processor asset layout.

Two source layouts are understood:
- the research package of v1 (side_projects/doy_estimation/deploy.py):
  {s2,nos2}/seed*.pt with colour statistics and the full training config;
- the AerialStamp layout (v2 on): {s2,image}/seed*.pt with a reduced config.
  AerialStamp always zeroes the static site facts 7 and 8 (S2 / match
  availability; aerialstamp/constants.py STATIC_MASKED), so the converted
  configs carry them as `static_masked`. Its image-only model becomes the
  processor's `nos2` model type.

Each seed is a pickled torch dict. The processor must not unpickle model files, so every seed
becomes a safetensors file (weights + colour normalisation) and everything
else (recipe, dims, calibration, cross-validated metrics) goes into
manifest.json. The frozen DINOv2 backbone is stored next to it, so inference
never downloads weights at runtime.

usage: package_doy_estimation_model.py <deploy_dir> <out_dir> --version doy_estimation_v2
Run it where the research package and timm's pretrained weights are reachable;
it needs torch, timm and safetensors. The backbone is resized to 224 px when
timm loads it, and timm versions round that differently (~1e-8), so pass
--backbone with the previous version's file when the backbone is unchanged.
"""

import argparse
import glob
import hashlib
import json
import os
import shutil

import torch
from safetensors.torch import save_file

# processor model type -> its directory in the research / AerialStamp package
SOURCE_DIRS = {'s2': ('s2',), 'nos2': ('nos2', 'image')}
AERIALSTAMP_STATIC_MASKED = [7, 8]
# keys the processor's DOYModel reads that AerialStamp configs leave out
# (their AerialStamp values; dropout is inactive at inference)
PROCESSOR_CFG_DEFAULTS = {'p1m': False, 'ov': False, 'pheno': False, 'feat_drop': 0.0, 'wk': 'all', 'noyear': 0}
BACKBONE = 'vit_base_patch14_reg4_dinov2.lvd142m'
BACKBONE_FILE = 'dinov2_vitb14_reg4.safetensors'


def sha256(path):
	h = hashlib.sha256()
	with open(path, 'rb') as f:
		for block in iter(lambda: f.read(1 << 20), b''):
			h.update(block)
	return h.hexdigest()


def convert_seed(src, dst, static_masked):
	ck = torch.load(src, map_location='cpu', weights_only=False)
	tensors = {f'state.{k}': v.contiguous() for k, v in ck['state'].items()}
	for scale, (mean, std) in ck.get('col_stats', {}).items():
		tensors[f'col_stats.{scale}.mean'] = mean.contiguous()
		tensors[f'col_stats.{scale}.std'] = std.contiguous()
	save_file(tensors, dst)
	cfg = {**PROCESSOR_CFG_DEFAULTS, **ck['cfg']}
	if static_masked:
		cfg['static_masked'] = static_masked
	return {
		'cfg': cfg,
		'emb_dim': int(ck['emb_dim']),
		's2_dim': int(ck['s2_dim']),
		'static_dim': int(ck['static_dim']),
		'n_train': int(ck.get('n_train', 0)),
	}


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument('deploy_dir')
	ap.add_argument('out_dir')
	ap.add_argument('--version', required=True)
	ap.add_argument(
		'--backbone',
		help=f'copy this {BACKBONE_FILE} (e.g. from the previous version) instead of fetching it with timm',
	)
	a = ap.parse_args()
	os.makedirs(a.out_dir, exist_ok=False)
	src_manifest = json.load(open(f'{a.deploy_dir}/manifest.json'))
	calibration = json.load(open(f'{a.deploy_dir}/calibration.json'))
	aerialstamp = os.path.isdir(f'{a.deploy_dir}/image')
	static_masked = AERIALSTAMP_STATIC_MASKED if aerialstamp else []
	models = {}
	for m, candidates in SOURCE_DIRS.items():
		src_dir = next(d for d in candidates if os.path.isdir(f'{a.deploy_dir}/{d}'))
		seeds = []
		for k, src in enumerate(sorted(glob.glob(f'{a.deploy_dir}/{src_dir}/seed*.pt'))):
			name = f'{m}_seed{k}.safetensors'
			info = convert_seed(src, f'{a.out_dir}/{name}', static_masked)
			info['file'] = name
			info['sha256'] = sha256(f'{a.out_dir}/{name}')
			seeds.append(info)
		assert seeds, f'no {m} seeds in {a.deploy_dir}'
		models[m] = {'seeds': seeds, 'calibration': calibration[src_dir], 'source_dir': src_dir}

	if a.backbone:
		shutil.copyfile(a.backbone, f'{a.out_dir}/{BACKBONE_FILE}')
	else:
		import timm

		backbone = timm.create_model(BACKBONE, pretrained=True, num_classes=0, img_size=224)
		save_file({k: v.contiguous() for k, v in backbone.state_dict().items()}, f'{a.out_dir}/{BACKBONE_FILE}')

	manifest = {
		'version': a.version,
		'source_package': os.path.abspath(a.deploy_dir),
		'source_created': src_manifest.get('created'),
		'source_version': src_manifest.get('version'),
		'source_note': src_manifest.get('note'),
		'source_code_rev': src_manifest.get('code_rev'),
		'source_runs': src_manifest.get('runs'),
		'backbone': {'timm_name': BACKBONE, 'file': BACKBONE_FILE, 'sha256': sha256(f'{a.out_dir}/{BACKBONE_FILE}')},
		'models': models,
		'cross_validated': src_manifest.get('cross_validated'),
	}
	with open(f'{a.out_dir}/manifest.json', 'w') as f:
		json.dump(manifest, f, indent=1, default=float)
	print(json.dumps({m: len(v['seeds']) for m, v in models.items()}), 'backbone', BACKBONE_FILE)


if __name__ == '__main__':
	main()
