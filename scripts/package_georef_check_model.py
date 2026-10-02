#!/usr/bin/env python3
"""Build the georeferencing-check matcher asset (models/georef_check_v1).

Downloads the RoMa v2 checkpoint (v2.0.1, MIT) and converts it to safetensors,
because the processor must not unpickle model files; the checkpoint already
holds the DINOv3 backbone and VGG19 refiner weights. The DINOv3 hub repository
(code only, commit adc2544, DINOv3 License) is copied next to it, so the
vendored matcher builds the backbone without network access at runtime.

usage: package_georef_check_model.py <out_dir>
then:  tar -czf georef_check_v1.tar.gz -C <out_dir> georef_check_v1
and upload the archive to <ASSETS_BASE_URL>/models/ (see Makefile).
Needs torch, safetensors and git.
"""

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

import torch
from safetensors.torch import save_file

CHECKPOINT_URL = 'https://github.com/Parskatt/RoMaV2/releases/download/v2.0.1/romav2.0.1.pt'
DINOV3_REPO = 'https://github.com/facebookresearch/dinov3.git'
DINOV3_COMMIT = 'adc254450203739c8149213a7a69d8d905b4fcfa'
NAME = 'georef_check_v1'


def sha256(path):
	h = hashlib.sha256()
	with open(path, 'rb') as f:
		for block in iter(lambda: f.read(1 << 20), b''):
			h.update(block)
	return h.hexdigest()


def main():
	ap = argparse.ArgumentParser()
	ap.add_argument('out_dir')
	args = ap.parse_args()
	out = Path(args.out_dir) / NAME
	if out.exists():
		raise SystemExit(f'{out} exists')
	out.mkdir(parents=True)
	with tempfile.TemporaryDirectory() as tmp:
		pt = Path(tmp) / 'romav2.0.1.pt'
		urllib.request.urlretrieve(CHECKPOINT_URL, pt)
		state = torch.load(pt, map_location='cpu', weights_only=True)
		save_file({k: v.contiguous() for k, v in state.items()}, out / 'romav2.safetensors')
		(out / 'romav2.safetensors').chmod(0o644)  # the worker container reads it as another user
		repo = Path(tmp) / 'dinov3'
		subprocess.run(['git', 'clone', '--quiet', DINOV3_REPO, str(repo)], check=True)
		subprocess.run(['git', '-C', str(repo), 'checkout', '--quiet', DINOV3_COMMIT], check=True)
		shutil.copytree(repo, out / 'dinov3', ignore=shutil.ignore_patterns('.git', 'notebooks', '*.ipynb'))
	manifest = {
		'name': NAME,
		'matcher': 'RoMa v2.0.1 (MIT), vendored in processor/src/georef_check_v1/romav2',
		'checkpoint_url': CHECKPOINT_URL,
		'dinov3_commit': DINOV3_COMMIT,
		'sha256': {'romav2.safetensors': sha256(out / 'romav2.safetensors')},
	}
	(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
	print(json.dumps(manifest, indent=2))


if __name__ == '__main__':
	main()
