"""Run the prediction quality check on one dataset.

Inputs are fetched by the caller (worker or benchmark): the COG path or URL, the dataset's CLIP
tiles, the AOI and the prediction polygons (WGS84 shapely geometries), and the judges. The check
picks the two crop sets, renders each crop once, asks every judge in parallel, and returns every
answer plus the per-layer verdicts of the current rule. Nothing is written here.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Sequence

import rasterio
from pyproj import Transformer
from shapely.geometry import box

from . import judge as judge_mod
from . import rule as rule_mod
from .render import Crop, judge_images, render_crop
from .tiles import Tile, attach_cover, crop_count, exclude_set, project, training_set, utm_epsg

CHECK_VERSION = 'prediction_quality_v1'


@dataclass
class CropResult:
	tile: Tile
	crop: Crop | None = None
	answers: list = field(default_factory=list)  # judge.Answer
	failures: dict = field(default_factory=dict)  # judge -> error text
	combined: dict = field(default_factory=dict)  # layer -> judge.combined(...)


@dataclass
class CheckResult:
	dataset_id: int
	epsg: int
	crops: list  # CropResult
	verdicts: dict  # layer -> rule.dataset_verdict(...)
	tiles_total: int
	seconds: float
	versions: dict = field(
		default_factory=lambda: {
			'check': CHECK_VERSION,
			'prompt': judge_mod.PROMPT_VERSION,
			'rule': rule_mod.RULE_VERSION,
		}
	)


def pick(tiles: Sequence[Tile], hectares: float, seed: int) -> list[Tile]:
	"""Both crop sets; a tile in both is rendered and judged once."""
	n = crop_count(hectares)
	chosen = {t.tile_id: t for t in exclude_set(tiles)}
	for t in training_set(tiles, n, seed):
		chosen[t.tile_id] = t
	return list(chosen.values())


def run_prediction_quality(
	dataset_id: int,
	cog: str,
	tiles: Sequence[Tile],
	aoi_4326,
	deadwood_4326: Sequence,
	forest_4326: Sequence,
	hectares: float,
	judges: dict,
	workers: int = 4,
) -> CheckResult:
	start = time.monotonic()
	c = aoi_4326.centroid
	epsg = utm_epsg(c.x, c.y)
	to_utm = Transformer.from_crs(4326, epsg, always_xy=True)
	aoi = project(aoi_4326, to_utm).buffer(0)
	layers_utm = {
		'deadwood': [project(g, to_utm) for g in deadwood_4326],
		'forest': [project(g, to_utm) for g in forest_4326],
	}
	attach_cover(tiles, epsg, deadwood_4326, forest_4326)
	# Only tiles whose square lies inside the AOI judge the prediction there.
	inside = [t for t in tiles if box(*t.square_utm).intersection(aoi).area >= 0.9 * box(*t.square_utm).area]
	results = [CropResult(tile=t) for t in pick(inside, hectares, dataset_id)]

	with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_TIMEOUT='60'), rasterio.open(cog) as src:
		for r in results:
			near = {k: [g for g in v if g.intersects(box(*r.tile.square_utm))] for k, v in layers_utm.items()}
			r.crop = render_crop(src, epsg, r.tile.square_utm, near, aoi)

	def one(task):
		r, name, backend = task
		try:
			return r, name, judge_mod.ask(name, backend, judge_images(r.crop)), None
		except Exception as e:  # one judge failing on one crop does not stop the check
			return r, name, None, f'{type(e).__name__}: {str(e)[:200]}'

	tasks = [(r, name, backend) for r in results for name, backend in judges.items()]
	with ThreadPoolExecutor(max(1, workers)) as pool:
		for r, name, answer, error in pool.map(one, tasks):
			if answer is not None:
				r.answers.append(answer)
			else:
				r.failures[name] = error
	for r in results:
		r.combined = {layer: judge_mod.combined(r.answers, layer) for layer in judge_mod.LAYERS}

	verdicts = {}
	for layer in judge_mod.LAYERS:
		exclude = [{'combined': r.combined[layer]} for r in results if 'exclude' in r.tile.sets]
		training = [
			{'combined': r.combined[layer], 'weight': r.tile.weight} for r in results if 'training' in r.tile.sets
		]
		verdicts[layer] = rule_mod.dataset_verdict(layer, exclude, training)
	return CheckResult(
		dataset_id=dataset_id,
		epsg=epsg,
		crops=results,
		verdicts=verdicts,
		tiles_total=len(inside),
		seconds=round(time.monotonic() - start, 1),
	)
