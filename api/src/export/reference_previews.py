"""Small WebP previews of exported reference patch PNGs.

The release gallery shows patches at about 166 px, so it loads a 512 px WebP
next to each RGB PNG instead of the full 1024 px file. Previews are written
when a patch PNG is exported and backfilled for PNGs that predate them.
"""

import os
from pathlib import Path

from PIL import Image

PREVIEW_SUFFIX = '_preview'
PREVIEW_SIZE_PX = 512
MASK_SUFFIXES = ('_deadwood_ref', '_forestcover_ref')


def preview_path_for(png_path: Path) -> Path:
	return png_path.with_name(f'{png_path.stem}{PREVIEW_SUFFIX}.webp')


def is_rgb_patch_png(path: Path) -> bool:
	return path.is_file() and path.suffix.lower() == '.png' and not path.stem.endswith(MASK_SUFFIXES)


def write_preview(png_path: Path) -> Path:
	"""Write the preview for one RGB PNG, replacing it atomically for nginx readers."""
	preview_path = preview_path_for(png_path)
	temp_path = preview_path.with_name(f'.{preview_path.name}.tmp')
	with Image.open(png_path) as img:
		preview = img.convert('RGB').resize((PREVIEW_SIZE_PX, PREVIEW_SIZE_PX), Image.LANCZOS)
		preview.save(temp_path, 'WEBP', quality=80, method=6)
	os.replace(temp_path, preview_path)
	return preview_path


def backfill_previews(output_base_dir: Path, dataset_ids: list[int]) -> int:
	"""Write missing or outdated previews for the exported datasets; return how many."""
	written = 0
	for dataset_id in dataset_ids:
		png_dir = output_base_dir / str(dataset_id) / 'png'
		if not png_dir.exists():
			continue
		for png_path in png_dir.iterdir():
			if not is_rgb_patch_png(png_path):
				continue
			preview_path = preview_path_for(png_path)
			if preview_path.exists() and preview_path.stat().st_mtime >= png_path.stat().st_mtime:
				continue
			write_preview(png_path)
			written += 1
	if written:
		print(f'✓ Wrote {written} gallery preview(s)\n')
	return written
