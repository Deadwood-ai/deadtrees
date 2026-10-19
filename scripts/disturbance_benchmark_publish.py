#!/usr/bin/env python3
"""Publish a forest disturbance benchmark export from the lab NAS to the storage server.

Each conversion run on the NAS (``.../11-Webviewer_visuals/runs/<run-id>/export``)
becomes one web build: JPEGs and PNG masks are converted to WebP (masks lossless),
heavy RGB images (drone, Google, Esri) get a small preview for tiles and strips, the JSON paths are
rewritten, and every referenced file is checked. The build is uploaded next to the
earlier ones (unchanged files are hard-linked to the current version) and then
``current`` is switched to it. Switching back to an older run is the rollback.

    disturbance_benchmark_publish.py build [RUN_DIR]
    disturbance_benchmark_publish.py publish [RUN_DIR] [--dry-run]
    disturbance_benchmark_publish.py switch RUN_ID
    disturbance_benchmark_publish.py status

Without RUN_DIR the newest run with a clean handoff audit is used. Needs Pillow
with WebP support and the processing server's storage key; see
docs/releases/disturbance-benchmark-internal.md.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

RUNS_ROOT = Path(
	os.environ.get(
		'BENCHMARK_RUNS_ROOT', '/mnt/gsdata/projects/deadtrees/disturbances/11-Webviewer_visuals/runs'
	)
)
BUILDS_ROOT = Path(os.environ.get('BENCHMARK_BUILDS_ROOT', '~/data/disturbance-benchmark/builds')).expanduser()
# The release folder on the storage server, reached with the processing server's
# existing storage key (the one the processors upload with).
REMOTE = os.environ.get('BENCHMARK_REMOTE', 'root@data2.deadtrees.earth:/data/releases/disturbance-benchmark/')
SSH_KEY = Path(os.environ.get('BENCHMARK_SSH_KEY', '~/.ssh/processing-to-storage')).expanduser()

JPEG_QUALITY = 80
PREVIEW_MAX_SIDE = 640
# Only images heavier than this get a preview; small Planet frames are cheaper as they are.
PREVIEW_MIN_BYTES = 100_000
COORDINATE_DECIMALS = 5
DATA_PREFIX = '/data/'


@dataclass(frozen=True)
class Converted:
	source: str
	target: str
	preview: str | None
	bytes_in: int
	bytes_out: int


def webp_name(relative: str, suffix: str = '') -> str:
	return str(Path(relative).with_suffix('')) + suffix + '.webp'


def convert_image(job: tuple[Path, Path, str]) -> Converted:
	from PIL import Image

	source_root, out_root, relative = job
	source = source_root / relative
	target = webp_name(relative)
	(out_root / target).parent.mkdir(parents=True, exist_ok=True)
	preview = None
	with Image.open(source) as image:
		if source.suffix.lower() == '.png':
			# Masks stay exact: lossless WebP keeps every pixel and the alpha channel.
			image.save(out_root / target, 'WEBP', lossless=True, method=6)
		else:
			rgb = image if image.mode == 'RGB' else image.convert('RGB')
			rgb.save(out_root / target, 'WEBP', quality=JPEG_QUALITY, method=6)
			if (out_root / target).stat().st_size > PREVIEW_MIN_BYTES and max(rgb.size) > PREVIEW_MAX_SIDE:
				preview = webp_name(relative, '.preview')
				rgb.thumbnail((PREVIEW_MAX_SIDE, PREVIEW_MAX_SIDE))  # full size is already saved
				rgb.save(out_root / preview, 'WEBP', quality=JPEG_QUALITY, method=6)
	bytes_out = (out_root / target).stat().st_size
	return Converted(relative, target, preview, source.stat().st_size, bytes_out)


def round_coordinates(value, decimals: int = COORDINATE_DECIMALS):
	if isinstance(value, list):
		return [round_coordinates(item, decimals) for item in value]
	return round(value, decimals) if isinstance(value, float) else value


def rewrite(value, paths: dict[str, Converted]):
	"""Point image paths at their WebP files and add ``preview`` next to large images."""
	if isinstance(value, str):
		converted = paths.get(value.removeprefix(DATA_PREFIX)) if value.startswith(DATA_PREFIX) else None
		return DATA_PREFIX + converted.target if converted else value
	if isinstance(value, list):
		return [rewrite(item, paths) for item in value]
	if not isinstance(value, dict):
		return value
	result = {}
	for key, item in value.items():
		if key == 'referencePolygons' or key == 'coordinates':
			item = round_coordinates(item)
		result[key] = rewrite(item, paths)
		previews = {'image': 'preview', 'drone': 'dronePreview'}
		if key in previews and isinstance(item, str) and item.startswith(DATA_PREFIX):
			converted = paths.get(item.removeprefix(DATA_PREFIX))
			if converted and converted.preview:
				result[previews[key]] = DATA_PREFIX + converted.preview
	return result


def referenced_paths(value) -> set[str]:
	if isinstance(value, str):
		return {value.removeprefix(DATA_PREFIX)} if value.startswith(DATA_PREFIX) else set()
	items = value.values() if isinstance(value, dict) else value if isinstance(value, list) else []
	return set().union(*(referenced_paths(item) for item in items))


def newest_run(runs_root: Path) -> Path:
	candidates = []
	for run in runs_root.iterdir():
		audit = run / 'handoff-audit.json'
		if (run / 'export' / 'catalog.json').is_file() and audit.is_file():
			missing = json.loads(audit.read_text()).get('missingReferences')
			if not missing:
				candidates.append(run)
	if not candidates:
		raise SystemExit(f'No run with export/catalog.json and a clean handoff-audit.json under {runs_root}')
	return max(candidates, key=lambda run: (run / 'export' / 'catalog.json').stat().st_mtime)


def build(run: Path, builds_root: Path | None = None, workers: int = 16) -> Path:
	builds_root = builds_root or BUILDS_ROOT
	source_root = run / 'export'
	out = builds_root / run.name
	if (out / 'build.json').is_file():
		print(f'Build {out} exists; reusing it.')
		return out
	staging = builds_root / f'.{run.name}.partial'
	shutil.rmtree(staging, ignore_errors=True)
	staging.mkdir(parents=True)

	files = sorted(path.relative_to(source_root).as_posix() for path in source_root.rglob('*') if path.is_file())
	images = [relative for relative in files if Path(relative).suffix.lower() in {'.jpg', '.jpeg', '.png'}]
	documents = [relative for relative in files if relative.endswith('.json')]
	others = sorted(set(files) - set(images) - set(documents))

	with ProcessPoolExecutor(max_workers=workers) as pool:
		converted = list(pool.map(convert_image, [(source_root, staging, relative) for relative in images], chunksize=32))
	paths = {item.source: item for item in converted}
	for relative in others:
		(staging / relative).parent.mkdir(parents=True, exist_ok=True)
		shutil.copy2(source_root / relative, staging / relative)

	referenced: set[str] = set()
	for relative in documents:
		document = rewrite(json.loads((source_root / relative).read_text()), paths)
		referenced |= referenced_paths(document)
		(staging / relative).parent.mkdir(parents=True, exist_ok=True)
		(staging / relative).write_text(json.dumps(document, separators=(',', ':')))
	missing = {path for path in referenced if not (staging / path).is_file()}
	if missing:
		raise SystemExit(f'{len(missing)} referenced files are missing, e.g. {sorted(missing)[:5]}')

	summary = {
		'run': run.name,
		'source': str(source_root),
		'files': sum(1 for path in staging.rglob('*') if path.is_file()),
		'imageBytesIn': sum(item.bytes_in for item in converted),
		'imageBytesOut': sum(item.bytes_out for item in converted),
		'previews': sum(1 for item in converted if item.preview),
		'bytes': sum(path.stat().st_size for path in staging.rglob('*') if path.is_file()),
	}
	(staging / 'build.json').write_text(json.dumps(summary, indent=1))
	staging.rename(out)
	print(json.dumps(summary))
	return out


def rsync(*args: str, dry_run: bool = False) -> subprocess.CompletedProcess:
	ssh = ['--rsh', f'ssh -i {SSH_KEY} -o IdentitiesOnly=yes -o BatchMode=yes'] if ':' in REMOTE else []
	command = ['rsync', *ssh, *(['--dry-run', '--itemize-changes'] if dry_run else []), *args]
	return subprocess.run(command, check=True, text=True, capture_output=True)


def remote_current() -> str | None:
	"""Run id that ``current`` points at on the storage server, if any."""
	try:
		listing = rsync('--list-only', '--links', f'{REMOTE}current').stdout
	except subprocess.CalledProcessError:
		return None
	return listing.rsplit(' -> ', 1)[1].strip() if ' -> ' in listing else None


def switch(run_id: str, dry_run: bool = False) -> None:
	if not dry_run:
		rsync('--list-only', f'{REMOTE}{run_id}/catalog.json')  # fails if that run was never uploaded
	with tempfile.TemporaryDirectory() as folder:
		(Path(folder) / 'current').symlink_to(run_id)
		rsync('-l', f'{folder}/current', REMOTE, dry_run=dry_run)
	print(f'current -> {run_id}' + (' (dry run)' if dry_run else ''))


def publish(run: Path, dry_run: bool = False) -> None:
	out = build(run)
	previous = remote_current()
	link = [f'--link-dest=../{previous}'] if previous and previous != run.name else []
	# Compare by content, not time: each build writes new mtimes, and --link-dest only
	# links files whose compared attributes match.
	result = rsync('-rlp', '--checksum', '--mkpath', *link, f'{out}/', f'{REMOTE}{run.name}/', dry_run=dry_run)
	if dry_run:
		print(result.stdout[-2000:])
	switch(run.name, dry_run=dry_run)
	if previous and previous != run.name:
		print(f'Rollback: {Path(sys.argv[0]).name} switch {previous}')


def status() -> None:
	print(rsync('--list-only', '--links', REMOTE).stdout)


def main(argv: list[str] | None = None) -> None:
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	commands = parser.add_subparsers(dest='command', required=True)
	for name in ('build', 'publish'):
		command = commands.add_parser(name)
		command.add_argument('run', nargs='?', type=Path, help='NAS run folder (default: newest clean run)')
		if name == 'publish':
			command.add_argument('--dry-run', action='store_true')
	switch_command = commands.add_parser('switch')
	switch_command.add_argument('run_id')
	switch_command.add_argument('--dry-run', action='store_true')
	commands.add_parser('status')
	args = parser.parse_args(argv)

	if args.command == 'status':
		status()
	elif args.command == 'switch':
		switch(args.run_id, dry_run=args.dry_run)
	else:
		run = args.run or newest_run(RUNS_ROOT)
		build(run) if args.command == 'build' else publish(run, dry_run=args.dry_run)


if __name__ == '__main__':
	main()
