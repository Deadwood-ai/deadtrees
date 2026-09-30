#!/usr/bin/env python3
"""Convert a DOY-estimation deploy package into the processor asset layout.

The research package (side_projects/doy_estimation/deploy.py, e.g.
/net/scratch/cmosig/datasets/doy_estimation/deploy/v1) stores each seed as a
pickled torch dict. The processor must not unpickle model files, so every seed
becomes a safetensors file (weights + colour normalisation) and everything
else (recipe, dims, calibration, cross-validated metrics) goes into
manifest.json. The frozen DINOv2 backbone is stored next to it, so inference
never downloads weights at runtime.

usage: package_doy_estimation_model.py <deploy_dir> <out_dir> --version doy_estimation_v1
Run it where the research package and timm's pretrained weights are reachable;
it needs torch, timm and safetensors.
"""

import argparse
import glob
import hashlib
import json
import os

import torch
from safetensors.torch import save_file

MODELS = ('s2', 'nos2')
BACKBONE = 'vit_base_patch14_reg4_dinov2.lvd142m'
BACKBONE_FILE = 'dinov2_vitb14_reg4.safetensors'


def sha256(path):
	h = hashlib.sha256()
	with open(path, 'rb') as f:
		for block in iter(lambda: f.read(1 << 20), b''):
			h.update(block)
	return h.hexdigest()


def convert_seed(src, dst):
	ck = torch.load(src, map_location='cpu', weights_only=False)
	tensors = {f'state.{k}': v.contiguous() for k, v in ck['state'].items()}
	for scale, (mean, std) in ck['col_stats'].items():
		tensors[f'col_stats.{scale}.mean'] = mean.contiguous()
		tensors[f'col_stats.{scale}.std'] = std.contiguous()
	save_file(tensors, dst)
	return {
		'cfg': ck['cfg'],
		'emb_dim': int(ck['emb_dim']),
		'col_dim': int(ck['col_dim']),
		's2_dim': int(ck['s2_dim']),
		'static_dim': int(ck['static_dim']),
		'n_train': int(ck.get('n_train', 0)),
	}


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument('deploy_dir')
	ap.add_argument('out_dir')
	ap.add_argument('--version', required=True)
	a = ap.parse_args()
	os.makedirs(a.out_dir, exist_ok=False)
	src_manifest = json.load(open(f'{a.deploy_dir}/manifest.json'))
	calibration = json.load(open(f'{a.deploy_dir}/calibration.json'))
	models = {}
	for m in MODELS:
		seeds = []
		for k, src in enumerate(sorted(glob.glob(f'{a.deploy_dir}/{m}/seed*.pt'))):
			name = f'{m}_seed{k}.safetensors'
			info = convert_seed(src, f'{a.out_dir}/{name}')
			info['file'] = name
			info['sha256'] = sha256(f'{a.out_dir}/{name}')
			seeds.append(info)
		assert seeds, f'no {m} seeds in {a.deploy_dir}'
		models[m] = {'seeds': seeds, 'calibration': calibration[m]}

	import timm

	backbone = timm.create_model(BACKBONE, pretrained=True, num_classes=0, img_size=224)
	save_file({k: v.contiguous() for k, v in backbone.state_dict().items()}, f'{a.out_dir}/{BACKBONE_FILE}')

	manifest = {
		'version': a.version,
		'source_package': os.path.abspath(a.deploy_dir),
		'source_created': src_manifest.get('created'),
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
