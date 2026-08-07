#!/usr/bin/env python3

from __future__ import annotations

import json
import os
import struct
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from shared import asset_manifest
from shared.operator_env import load_env_file


MAX_SAFETENSORS_HEADER_BYTES = 16 * 1024 * 1024


def valid_safetensors(path: Path, minimum_tensors: int, required_tensors: tuple[str, ...]) -> bool:
	try:
		file_size = path.stat().st_size
		with path.open('rb') as checkpoint:
			header_size_raw = checkpoint.read(8)
			if len(header_size_raw) != 8:
				return False
			header_size = struct.unpack('<Q', header_size_raw)[0]
			if not 0 < header_size <= MAX_SAFETENSORS_HEADER_BYTES or 8 + header_size > file_size:
				return False
			header = json.loads(checkpoint.read(header_size))
		if not isinstance(header, dict):
			return False
		tensors = {name: value for name, value in header.items() if name != '__metadata__'}
		if len(tensors) < minimum_tensors or any(name not in tensors for name in required_tensors):
			return False
		payload_size = file_size - 8 - header_size
		for tensor in tensors.values():
			if not isinstance(tensor, dict) or not isinstance(tensor.get('dtype'), str):
				return False
			shape = tensor.get('shape')
			if not isinstance(shape, list) or not all(isinstance(size, int) and size >= 0 for size in shape):
				return False
			offsets = tensor.get('data_offsets')
			if (
				not isinstance(offsets, list)
				or len(offsets) != 2
				or not all(isinstance(offset, int) for offset in offsets)
				or not 0 <= offsets[0] <= offsets[1] <= payload_size
			):
				return False
		return True
	except (OSError, UnicodeDecodeError, json.JSONDecodeError, struct.error):
		return False


def resolve_assets_dir(repo_dir: Path) -> Path:
	if 'PROCESSOR_ASSETS_DIR' in os.environ:
		configured = os.environ['PROCESSOR_ASSETS_DIR']
	else:
		configured = load_env_file(repo_dir / '.env').get('PROCESSOR_ASSETS_DIR')
	assets_dir = Path(configured or 'assets').expanduser()
	if not assets_dir.is_absolute():
		assets_dir = repo_dir / assets_dir
	return assets_dir.resolve()


def missing_assets(assets_dir: Path) -> list[Path]:
	missing = [
		assets_dir / relative
		for relative in asset_manifest.required_processor_asset_files()
		if not (assets_dir / relative).is_file() or (assets_dir / relative).stat().st_size == 0
	]
	missing.extend(
		assets_dir / 'models' / name
		for name, (minimum_tensors, required_tensors) in asset_manifest.processor_model_checkpoint_specs().items()
		if not valid_safetensors(assets_dir / 'models' / name, minimum_tensors, required_tensors)
		and assets_dir / 'models' / name not in missing
	)
	missing.extend(
		assets_dir / relative
		for relative in asset_manifest.required_processor_asset_directories()
		if not (assets_dir / relative).is_dir()
		or not any(path.is_file() and not path.name.startswith('.') for path in (assets_dir / relative).iterdir())
	)
	return missing


def main() -> int:
	repo_dir = REPO_ROOT
	assets_dir = resolve_assets_dir(repo_dir)
	missing = missing_assets(assets_dir)
	if missing:
		print(f'Processor asset preflight failed for {assets_dir}:', file=sys.stderr)
		for path in missing:
			print(f'- missing {path.relative_to(assets_dir)}', file=sys.stderr)
		return 1
	print(f'Processor assets ready at {assets_dir}')
	return 0


if __name__ == '__main__':
	raise SystemExit(main())
