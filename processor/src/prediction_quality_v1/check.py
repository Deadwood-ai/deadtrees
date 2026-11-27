"""Run the prediction quality check on one dataset.

Inputs are fetched by the caller (worker handler or benchmark runner): the COG path or URL, the
candidate tiles with their predicted cover, the AOI, a reader of the prediction polygons near
given boxes, and the judges. The check picks the two tile sets from the candidates, reads the
polygons of the picked tiles only, renders each tile once, asks every judge in parallel, and
returns every answer. Nothing is written here; which judge decides is the database's rule.
"""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable, Sequence

import rasterio
from pyproj import CRS, Transformer
from rasterio.warp import transform_bounds

from ..audit_worker.models import LimitReached, LoginExpired
from ..utils.crs import get_utm_string_from_latlon
from . import judge as judge_mod
from .render import Crop, judge_images, render_crop
from .tiles import TILE_M, Tile, exclude_set, project, square_from_bbox, tile_count, training_set

VERSIONS = {'check': 'prediction_quality_v1', 'prompt': judge_mod.PROMPT_VERSION}


@dataclass
class TileResult:
	tile: Tile
	crop: Crop | None = None  # the tile rendered as the judges see it
	answers: list = field(default_factory=list)  # judge.Answer
	failures: dict = field(default_factory=dict)  # judge -> error text


@dataclass
class CheckResult:
	dataset_id: int
	epsg: int
	tiles: list  # TileResult
	tiles_total: int  # the dataset's tiles inside the AOI
	candidates: int  # of these, the tiles the sets were picked from
	seconds: float
	cost: dict = field(default_factory=dict)  # judge -> {'seconds', 'calls', 'cost_usd'}


def pick(tiles: Sequence[Tile], hectares: float, seed: int) -> list[Tile]:
	"""Both tile sets; a tile in both is rendered and judged once."""
	n = tile_count(hectares)
	chosen = {t.tile_id: t for t in exclude_set(tiles)}
	for t in training_set(tiles, n, seed):
		chosen[t.tile_id] = t
	return list(chosen.values())


def grid_epsg(src) -> int:
	"""The UTM zone of the CLIP tile grid: the zone of the ortho's centre, as the embedding stage picks it."""
	lon, lat = Transformer.from_crs(src.crs, 4326, always_xy=True).transform(
		*(src.transform @ (src.width / 2, src.height / 2))
	)
	return CRS.from_string(get_utm_string_from_latlon(lat, lon)).to_epsg()


def box_4326(square, epsg: int) -> tuple:
	"""The WGS84 box around a UTM square, a metre wider: the polygons are cut to it, and the
	cut edges stay off the crop."""
	x0, y0, x1, y1 = square
	return transform_bounds(f'EPSG:{epsg}', 'EPSG:4326', x0 - 1, y0 - 1, x1 + 1, y1 + 1)


def run_prediction_quality(
	dataset_id: int,
	cog: str,
	candidates: Sequence[Tile],
	tiles_total: int,
	aoi_4326,
	polygons: Callable[[str, list], list],
	judges: dict,
	workers: int = 4,
) -> CheckResult:
	"""candidates: tiles inside the AOI drawn from the dataset's tiles_total, with their
	predicted cover; polygons(layer, boxes) -> per WGS84 box (xmin, ymin, xmax, ymax) the
	layer's ('deadwood', 'forest') polygons in it as WGS84 shapely geometries, read once per
	layer for the picked tiles. aoi_4326 None judges every tile: a dataset without an AOI is
	predicted as a whole."""
	start = time.monotonic()
	with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_HTTP_TIMEOUT='60'), rasterio.open(cog) as src:
		epsg = grid_epsg(src)
		to_utm = Transformer.from_crs(4326, epsg, always_xy=True)
		aoi = project(aoi_4326, to_utm).buffer(0) if aoi_4326 is not None else None
		for t in candidates:
			t.square_utm = square_from_bbox(t.bbox_4326, to_utm)
		hectares = (aoi.area if aoi is not None else tiles_total * TILE_M**2) / 1e4
		results = [TileResult(tile=t) for t in pick(candidates, hectares, dataset_id)]
		boxes = [box_4326(r.tile.square_utm, epsg) for r in results]
		near = {layer: polygons(layer, boxes) for layer in judge_mod.LAYERS}
		for i, r in enumerate(results):
			layers = {layer: list(project(near[layer][i], to_utm)) for layer in judge_mod.LAYERS}
			r.crop = render_crop(src, epsg, r.tile.square_utm, layers, aoi)

	def one(task):
		r, name, backend = task
		asked = time.monotonic()
		try:
			answer, error = judge_mod.ask(name, backend, judge_images(r.crop), cover={layer: r.crop.cover(layer) for layer in judge_mod.LAYERS}), None
		except (LoginExpired, LimitReached):
			raise  # the worker pauses and runs the dataset again later
		except Exception as e:  # one judge failing on one tile does not stop the check
			answer, error = None, f'{type(e).__name__}: {str(e)[:200]}'
		return r, name, answer, error, time.monotonic() - asked

	tasks = [(r, name, backend) for r in results for name, backend in judges.items()]
	cost = {name: {'seconds': 0.0, 'calls': 0, 'cost_usd': None} for name in judges}
	answered = dict.fromkeys(judges, 0)
	with ThreadPoolExecutor(max(1, workers)) as pool:
		for r, name, answer, error, seconds in pool.map(one, tasks):
			cost[name]['seconds'] = round(cost[name]['seconds'] + seconds, 1)
			cost[name]['calls'] += 1
			if answer is not None:
				r.answers.append(answer)
				answered[name] += 1
			else:
				r.failures[name] = error
	# A judge that answers no tile at all is broken, not unlucky: the run is retried.
	silent = [name for name, count in answered.items() if results and not count]
	if silent:
		raise RuntimeError(f'{", ".join(silent)} answered no tile: {results[0].failures[silent[0]]}')
	return CheckResult(
		dataset_id=dataset_id,
		epsg=epsg,
		tiles=results,
		tiles_total=tiles_total,
		candidates=len(candidates),
		seconds=round(time.monotonic() - start, 1),
		cost=cost,
	)
