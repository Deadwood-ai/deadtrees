"""CLIP tile windows, their predicted cover, and the two tile sets.

The embedding stage tiles each ortho on a 10 cm UTM grid into 512 px squares and stores each
kept tile's pixel window and WGS84 footprint (v2_tile_embeddings). The check judges a tile as
the square of TILE_M metres centred on the stored footprint, in the dataset's UTM zone. The
sets are picked from CANDIDATES tiles the database draws, with their predicted cover
(audit.prediction_quality_candidates), so the work does not grow with the dataset.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Sequence

import numpy as np
from pyproj import Transformer
import shapely

TILE_M = 51.2  # 512 px at 10 cm, as in embedding_search.patch_embedding
CANDIDATES = 500  # tiles drawn from the dataset to pick the sets from
INSIDE_AOI = 0.9  # share of a tile that lies in the AOI for the tile to be judged
DEADWOOD_BINS = (0.0, 0.05, 0.20)  # predicted deadwood: none, under 5%, 5-20%, over 20%
FOREST_CLOSED = 0.6  # predicted forest: none, partial, closed (60% or more)
EXCLUDE_SET_SIZE = 10


@dataclass
class Tile:
	"""One CLIP tile: stored pixel window and footprint, plus the derived square."""

	tile_id: int
	pixel_window: tuple[int, int, int, int]
	bbox_4326: tuple[float, float, float, float]
	square_utm: tuple[float, float, float, float] = (0, 0, 0, 0)
	deadwood_share: float = 0.0
	forest_share: float = 0.0
	sets: list[str] = field(default_factory=list)
	weight: float | None = None  # area share of the dataset this tile stands for (training set)

	@property
	def stratum(self) -> tuple[int, int]:
		return stratum(self.deadwood_share, self.forest_share)


def project(geom, transformer: Transformer):
	"""A shapely geometry in the transformer's target CRS."""
	return shapely.transform(geom, lambda xy: np.column_stack(transformer.transform(xy[:, 0], xy[:, 1])))


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


def tile_count(hectares: float) -> int:
	"""1 tile per 2 ha, 10 to 40 per set (plan session 4)."""
	return int(min(40, max(10, round(hectares / 2))))


def exclude_set(tiles: Sequence[Tile], n: int = EXCLUDE_SET_SIZE) -> list[Tile]:
	"""The n tiles with the most predicted cover: where the audit judges the prediction."""
	ranked = sorted(tiles, key=lambda t: (-(t.deadwood_share + t.forest_share), t.tile_id))
	chosen = ranked[:n]
	for t in chosen:
		t.sets.append('exclude')
	return chosen


def training_set(tiles: Sequence[Tile], n: int, seed: int) -> list[Tile]:
	"""Stratified tiles over predicted cover, square-root allocation, each with its area weight.

	Rare high-deadwood strata get more tiles than their area share; the weight restores the
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
