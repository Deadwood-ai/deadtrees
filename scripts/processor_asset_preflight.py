#!/usr/bin/env python3

from __future__ import annotations

import os
import sys
from pathlib import Path


REQUIRED_FILES = (
	'models/segformer_b5_full_epoch_100.safetensors',
	'models/ckpt_weighted_brownweight15_goldentestweight7.safetensors',
	'models/b1_50epoch_best_macro_f1.safetensors',
	'gadm/gadm_410.gpkg',
	'biom/terres_ecosystems.gpkg',
)
REQUIRED_DIRECTORIES = ('pheno/modispheno_aggregated_normalized_filled.zarr',)


def _env_file_value(path: Path, name: str) -> str | None:
	if not path.exists():
		return None
	for raw_line in path.read_text().splitlines():
		line = raw_line.strip()
		if not line or line.startswith('#') or '=' not in line:
			continue
		key, value = line.split('=', 1)
		if key.strip() != name:
			continue
		value = value.strip()
		if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
			value = value[1:-1]
		return value
	return None


def resolve_assets_dir(repo_dir: Path) -> Path:
	configured = os.environ.get('PROCESSOR_ASSETS_DIR') or _env_file_value(repo_dir / '.env', 'PROCESSOR_ASSETS_DIR')
	assets_dir = Path(configured or 'assets').expanduser()
	if not assets_dir.is_absolute():
		assets_dir = repo_dir / assets_dir
	return assets_dir.resolve()


def missing_assets(assets_dir: Path) -> list[Path]:
	missing = [
		assets_dir / relative
		for relative in REQUIRED_FILES
		if not (assets_dir / relative).is_file() or (assets_dir / relative).stat().st_size == 0
	]
	missing.extend(
		assets_dir / relative
		for relative in REQUIRED_DIRECTORIES
		if not (assets_dir / relative).is_dir() or not any((assets_dir / relative).iterdir())
	)
	return missing


def main() -> int:
	repo_dir = Path(__file__).resolve().parents[1]
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
