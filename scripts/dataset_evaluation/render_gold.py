#!/usr/bin/env python3
"""Render what the dataset evaluation models see, for every gold-set dataset.

Uses the check's own input code (processor/src/dataset_evaluation_v1): the overview,
up to four crops and the website thumbnail, written under
<root>/datasets/<id>/ for the labeling page. Public and view-only COGs are read from
data2 over HTTPS; private ones only from a local copy (--cog-dir <dir>/<cog_path>),
otherwise they are skipped and listed. Paths come from the analyst login
(read-only). No model is called.

Run it under a memory cap, because production ODM runs on the processing server:

	set -a; . ~/.config/deadtrees/monitor.env; set +a
	systemd-run --user --scope -p MemoryMax=6G venv/bin/python scripts/dataset_evaluation/render_gold.py \\
		--root .local/dataset-evaluation --limit 20
"""

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dataset_evaluation.gold_set import analyst
from processor.src.dataset_evaluation_v1.check import model_images
from processor.src.dataset_evaluation_v1.inputs import Tile, read_inputs

DATA_URL = 'https://data2.deadtrees.earth'
SERVED = ('public', 'viewonly')  # the public file routes serve these; private files are refused


def sources(ids: list[int]) -> dict[int, dict]:
	with analyst() as db:
		rows = db.execute(
			'SELECT d.id, d.data_access::text, c.cog_path, t.thumbnail_path FROM public.v2_datasets d '
			'JOIN public.v2_cogs c ON c.dataset_id = d.id LEFT JOIN public.v2_thumbnails t ON t.dataset_id = d.id '
			'WHERE d.id = ANY(%s)',
			(ids,),
		).fetchall()
		tiles = db.execute(
			'SELECT dataset_id, pixel_x0, pixel_y0, pixel_x1, pixel_y1, ST_X(ST_Centroid(geometry)) AS lon, '
			'ST_Y(ST_Centroid(geometry)) AS lat FROM public.v2_tile_embeddings WHERE dataset_id = ANY(%s)',
			(ids,),
		).fetchall()
	out = {r['id']: dict(r, tiles=[]) for r in rows}
	for t in tiles:
		out[t['dataset_id']]['tiles'].append(
			Tile((t['pixel_x0'], t['pixel_y0'], t['pixel_x1'], t['pixel_y1']), (t['lon'], t['lat']))
		)
	return out


def render(dataset_id: int, source: dict, folder: Path, cog_dir: Path | None) -> str:
	if source['data_access'] in SERVED:
		cog = f'{DATA_URL}/cogs/v1/{quote(source["cog_path"], safe="/")}'
	elif cog_dir and (cog_dir / source['cog_path']).exists():
		cog = str(cog_dir / source['cog_path'])
	else:
		return 'private COG not available locally'
	thumbnail = None
	if source['thumbnail_path'] and source['data_access'] in SERVED:
		with urlopen(f'{DATA_URL}/thumbnails/v1/{quote(source["thumbnail_path"], safe="/")}', timeout=60) as r:
			thumbnail = r.read(5_000_000)
	inputs = read_inputs(cog, seed=dataset_id, tiles=source['tiles'])
	folder.mkdir(parents=True, exist_ok=True)
	images = model_images(inputs, thumbnail)
	# The labeling page reads fixed names; the check's own content-based names are for the storage server.
	names = [
		'overview.jpg'
		if image.kind == 'overview'
		else 'thumbnail.jpg'
		if image.kind == 'thumbnail'
		else f'crop-{image.crop_index + 1}.jpg'
		for image in images
	]
	for name, image in zip(names, images):
		(folder / name).write_bytes(image.data)
	(folder / 'inputs.json').write_text(
		json.dumps(
			{
				'images': names,
				'mpp': {'overview': inputs.overview_mpp, 'crop': inputs.crops[0].mpp if inputs.crops else None},
				'crops': [
					{'grid_window': c.grid_window, 'cog_window': c.cog_window, 'picker': c.picker} for c in inputs.crops
				],
				'settings': inputs.settings,
			},
			indent=1,
		)
		+ '\n'
	)
	return 'ok'


def main():
	parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
	parser.add_argument('--root', type=Path, required=True, help='folder with gold-set.json')
	parser.add_argument('--cog-dir', type=Path, help='local COG copies for private datasets, by cog_path')
	parser.add_argument('--ids', type=int, nargs='*', help='only these datasets')
	parser.add_argument('--limit', type=int, help='at most this many datasets')
	args = parser.parse_args()
	gold = json.loads((args.root / 'gold-set.json').read_text())
	ids = [d['dataset_id'] for d in gold['datasets'] if not args.ids or d['dataset_id'] in args.ids]
	todo = [i for i in ids if not (args.root / 'datasets' / str(i) / 'inputs.json').exists()][: args.limit]
	found = sources(todo)
	skipped = {}
	for n, dataset_id in enumerate(todo, 1):
		try:
			result = (
				render(dataset_id, found[dataset_id], args.root / 'datasets' / str(dataset_id), args.cog_dir)
				if dataset_id in found
				else 'no COG'
			)
		except Exception as e:  # one unreadable COG must not stop the set
			result = f'{type(e).__name__}: {e}'[:200]
		if result != 'ok':
			skipped[dataset_id] = result
		print(f'{n}/{len(todo)} {dataset_id}: {result}', flush=True)
	(args.root / 'render-skipped.json').write_text(json.dumps(skipped, indent=1) + '\n')


if __name__ == '__main__':
	main()
