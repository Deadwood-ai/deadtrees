#!/usr/bin/env python3

from __future__ import annotations

import itertools
import json
import math
import os
import sqlite3
import struct
import sys
from contextlib import closing
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from shared import asset_manifest
from shared.operator_env import load_env_file


MAX_SAFETENSORS_HEADER_BYTES = 16 * 1024 * 1024


def contained_asset(path: Path, assets_dir: Path) -> bool:
	try:
		path.resolve().relative_to(assets_dir.resolve())
		return True
	except (OSError, ValueError):
		return False


def valid_geopackage(path: Path, layer: str, required_columns: tuple[str, ...]) -> bool:
	try:
		with closing(sqlite3.connect(f'file:{path}?mode=ro', uri=True)) as database:
			page_size = database.execute('PRAGMA page_size').fetchone()[0]
			page_count = database.execute('PRAGMA page_count').fetchone()[0]
			content = database.execute(
				'SELECT table_name FROM gpkg_contents WHERE table_name = ?',
				(layer,),
			).fetchone()
			columns = {row[1] for row in database.execute(f'PRAGMA table_info("{layer}")')}
		return (
			page_size > 0
			and page_count > 0
			and path.stat().st_size == page_size * page_count
			and content == (layer,)
			and set(required_columns).issubset(columns)
		)
	except (OSError, sqlite3.Error):
		return False


def valid_zarr_store(store: Path, assets_dir: Path) -> bool:
	try:
		consolidated = json.loads((store / '.zmetadata').read_text())
		if consolidated.get('zarr_consolidated_format') != 1 or not isinstance(consolidated.get('metadata'), dict):
			return False
		consolidated_metadata = consolidated['metadata']
		if consolidated_metadata.get('.zgroup', {}).get('zarr_format') != 2:
			return False
		for name, (expected_shape, expected_chunks, omitted_chunks) in asset_manifest.PHENOLOGY_ARRAY_SPECS.items():
			array_dir = store / name
			metadata = json.loads((array_dir / '.zarray').read_text())
			if tuple(metadata.get('shape', ())) != expected_shape or tuple(metadata.get('chunks', ())) != expected_chunks:
				return False
			if consolidated_metadata.get(f'{name}/.zarray') != metadata:
				return False
			array_attributes = consolidated_metadata.get(f'{name}/.zattrs')
			if (
				not isinstance(array_attributes, dict)
				or len(array_attributes.get('_ARRAY_DIMENSIONS', ())) != len(expected_shape)
			):
				return False
			separator = metadata.get('dimension_separator', '.')
			if separator not in {'.', '/'}:
				return False
			chunk_ranges = [range(math.ceil(size / chunk)) for size, chunk in zip(expected_shape, expected_chunks)]
			for coordinates in itertools.product(*chunk_ranges):
				chunk_key = separator.join(map(str, coordinates))
				if chunk_key in omitted_chunks:
					continue
				chunk = array_dir.joinpath(*map(str, coordinates)) if separator == '/' else array_dir / chunk_key
				if not contained_asset(chunk, assets_dir) or not chunk.is_file() or chunk.stat().st_size == 0:
					return False
		return True
	except (OSError, TypeError, ValueError, json.JSONDecodeError):
		return False


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


def matching_mount(assets_dir: Path, mounted_assets: Path) -> bool:
	return mounted_assets.resolve() == assets_dir.resolve()


def missing_assets(assets_dir: Path, task_blacklist: set[str] | frozenset[str] = frozenset()) -> list[Path]:
	missing = [
		assets_dir / relative
		for relative in asset_manifest.required_processor_asset_files(task_blacklist)
		if not contained_asset(assets_dir / relative, assets_dir)
		or not (assets_dir / relative).is_file()
		or (assets_dir / relative).stat().st_size == 0
	]
	missing.extend(
		assets_dir / 'models' / name
		for name, (minimum_tensors, required_tensors) in asset_manifest.processor_model_checkpoint_specs(
			task_blacklist
		).items()
		if not valid_safetensors(assets_dir / 'models' / name, minimum_tensors, required_tensors)
		and assets_dir / 'models' / name not in missing
	)
	if asset_manifest.METADATA_TASK_TYPE not in task_blacklist:
		missing.extend(
			assets_dir / relative
			for relative, (layer, required_columns) in asset_manifest.GEOPACKAGE_SPECS.items()
			if not valid_geopackage(assets_dir / relative, layer, required_columns)
			and assets_dir / relative not in missing
		)
	missing.extend(
		assets_dir / relative
		for relative in asset_manifest.required_processor_asset_directories(task_blacklist)
		if not contained_asset(assets_dir / relative, assets_dir)
		or not (assets_dir / relative).is_dir()
		or not any(path.is_file() and not path.name.startswith('.') for path in (assets_dir / relative).iterdir())
	)
	phenology_store = assets_dir / asset_manifest.PHENOLOGY_ASSET_PATH
	if (
		asset_manifest.METADATA_TASK_TYPE not in task_blacklist
		and phenology_store not in missing
		and not valid_zarr_store(phenology_store, assets_dir)
	):
		missing.append(phenology_store)
	return missing


def main() -> int:
	repo_dir = REPO_ROOT
	assets_dir = resolve_assets_dir(repo_dir)
	if sys.argv[1:] == ['--print-assets-dir']:
		print(assets_dir)
		return 0
	if len(sys.argv) == 3 and sys.argv[1] == '--mount-matches':
		return 0 if matching_mount(assets_dir, Path(sys.argv[2])) else 1
	if len(sys.argv) > 1:
		print(
			'Usage: processor_asset_preflight.py [--print-assets-dir | --mount-matches PATH]',
			file=sys.stderr,
		)
		return 2
	env_file = load_env_file(repo_dir / '.env')
	configured_blacklist = os.environ.get('PROCESSOR_TASK_BLACKLIST', env_file.get('PROCESSOR_TASK_BLACKLIST', ''))
	task_blacklist = {value.strip() for value in configured_blacklist.split(',') if value.strip()}
	missing = missing_assets(assets_dir, task_blacklist)
	if missing:
		print(f'Processor asset preflight failed for {assets_dir}:', file=sys.stderr)
		for path in missing:
			print(f'- missing {path.relative_to(assets_dir)}', file=sys.stderr)
		return 1
	print(f'Processor assets ready at {assets_dir}')
	return 0


if __name__ == '__main__':
	raise SystemExit(main())
