#!/usr/bin/env python3

from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from shared import asset_manifest
from shared.operator_env import load_env_file


def resolve_assets_dir(repo_dir: Path) -> Path:
	configured = os.environ.get('PROCESSOR_ASSETS_DIR') or load_env_file(repo_dir / '.env').get('PROCESSOR_ASSETS_DIR')
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
