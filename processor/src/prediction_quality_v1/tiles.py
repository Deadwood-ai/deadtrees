"""CLIP tile windows as crops, their predicted cover, and the two crop sets.

The embedding stage tiles each ortho on a 10 cm UTM grid into 512 px squares and stores each
kept tile's pixel window and WGS84 footprint (v2_tile_embeddings). A crop is one such tile:
the square of TILE_M metres centred on the stored footprint, in the dataset's UTM zone.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from typing import Iterable, Sequence

import numpy as np
from pyproj import Transformer
from rasterio.features import rasterize
from rasterio.transform import from_bounds
import shapely
from shapely import STRtree
from shapely.geometry import box

TILE_M = 51.2  # 512 px at 10 cm, as in embedding_search.patch_embedding
COVER_PX = 64  # cover share raster per tile (0.8 m cells)
DEADWOOD_BINS = (0.0, 0.05, 0.20)  # predicted deadwood: none, under 5%, 5-20%, over 20%
FOREST_CLOSED = 0.6  # predicted forest: none, partial, closed (60% or more)
EXCLUDE_SET_SIZE = 10


@dataclass
class Tile:
	"""One CLIP tile: stored pixel window and footprint, plus the derived crop square."""

	tile_id: int
	pixel_window: tuple[int, int, int, int]
	bbox_4326: tuple[float, float, float, float]
	square_utm: tuple[float, float, float, float] = (0, 0, 0, 0)
	deadwood_share: float = 0.0
	forest_share: float = 0.0
	sets: list[str] = field(default_factory=list)
	weight: float | None = None  # area share of the dataset this crop stands for (training set)

	@property
	def stratum(self) -> tuple[int, int]:
		return stratum(self.deadwood_share, self.forest_share)


def project(geom, transformer: Transformer):
	"""A shapely geometry in the transformer's target CRS."""
	return shapely.transform(geom, lambda xy: np.column_stack(transformer.transform(xy[:, 0], xy[:, 1])))


def utm_epsg(lon: float, lat: float) -> int:
	zone = min(max(int((lon + 180.0) // 6.0) + 1, 1), 60)
	return (32700 if lat < 0 else 32600) + zone


def square_from_bbox(bbox_4326: Sequence[float], to_utm: Transformer) -> tuple[float, float, float, float]:
	"""The 51.2 m tile square in UTM, centred on the stored WGS84 footprint."""
	lon = (bbox_4326[0] + bbox_4326[2]) / 2
	lat = (bbox_4326[1] + bbox_4326[3]) / 2
	x, y = to_utm.transform(lon, lat)
	h = TILE_M / 2
	return (x - h, y - h, x + h, y + h)


def stratum(deadwood: float, forest: float) -> tuple[int, int]:
	d = 0 if deadwood <= 0 else 1 + sum(deadwood > b for b in DEADWOOD_BINS[1:])
	f = 0 if forest <= 0 else (2 if forest >= FOREST_CLOSED else 1)
	return d, f


def attach_cover(tiles: Sequence[Tile], epsg: int, deadwood_geoms: Iterable, forest_geoms: Iterable) -> None:
	"""Set each tile's square and its predicted deadwood and forest share (polygons in WGS84)."""
	to_utm = Transformer.from_crs(4326, epsg, always_xy=True)
	layers = {}
	for name, geoms in (('deadwood', deadwood_geoms), ('forest', forest_geoms)):
		projected = [project(g, to_utm) for g in geoms if g is not None and not g.is_empty]
		layers[name] = (projected, STRtree(projected))
	for t in tiles:
		t.square_utm = square_from_bbox(t.bbox_4326, to_utm)
		cell = box(*t.square_utm)
		affine = from_bounds(*t.square_utm, COVER_PX, COVER_PX)
		for name, attr in (('deadwood', 'deadwood_share'), ('forest', 'forest_share')):
			projected, tree = layers[name]
			near = [(projected[i], 1) for i in tree.query(cell, predicate='intersects')]
			share = float(rasterize(near, out_shape=(COVER_PX, COVER_PX), transform=affine).mean()) if near else 0.0
			setattr(t, attr, share)


def crop_count(hectares: float) -> int:
	"""1 crop per 2 ha, 10 to 40 per set (plan session 4)."""
	return int(min(40, max(10, round(hectares / 2))))


def exclude_set(tiles: Sequence[Tile], n: int = EXCLUDE_SET_SIZE) -> list[Tile]:
	"""The n tiles with the most predicted cover: where the audit judges the prediction."""
	ranked = sorted(tiles, key=lambda t: (-(t.deadwood_share + t.forest_share), t.tile_id))
	chosen = ranked[: min(n, len(ranked))]
	for t in chosen:
		t.sets.append('exclude')
	return chosen


def training_set(tiles: Sequence[Tile], n: int, seed: int) -> list[Tile]:
	"""Stratified tiles over predicted cover, square-root allocation, each with its area weight.

	Rare high-deadwood strata get more crops than their area share; the weight restores the
	area share, so shares estimated from the set stay unbiased.
	"""
	rng = np.random.default_rng(seed)
	strata: dict[tuple[int, int], list[Tile]] = {}
	for t in sorted(tiles, key=lambda t: t.tile_id):
		strata.setdefault(t.stratum, []).append(t)
	keys = sorted(strata)
	if not keys:
		return []
	n = min(n, len(tiles))
	root = np.array([math.sqrt(len(strata[k])) for k in keys])
	sizes = np.array([len(strata[k]) for k in keys])
	quota = np.minimum(sizes, np.maximum(1, np.floor(n * root / root.sum()))).astype(int)
	while quota.sum() < n and (quota < sizes).any():
		gap = n * root / root.sum() - quota
		gap[quota >= sizes] = -np.inf
		quota[int(np.argmax(gap))] += 1
	chosen: list[Tile] = []
	for k, q in zip(keys, quota):
		members = strata[k]
		for i in rng.choice(len(members), size=int(q), replace=False):
			t = members[int(i)]
			t.weight = len(members) / q
			chosen.append(t)
	total = sum(t.weight for t in chosen)
	for t in chosen:
		t.weight = t.weight / total
		t.sets.append('training')
	return chosen


def benchmark_split(dataset_id: int, holdout_share: float = 0.2) -> str:
	"""Fixed development / holdout split by a hash of the dataset id (plan: set once, never moves)."""
	h = int(hashlib.sha256(f'audit-benchmark-v1:{dataset_id}'.encode()).hexdigest(), 16)
	return 'holdout' if (h % 1000) < holdout_share * 1000 else 'development'
