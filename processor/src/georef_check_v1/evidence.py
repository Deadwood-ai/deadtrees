"""Georeferencing evidence: from matched point pairs to a Good/Poor/uncertain call.

Each reference image (Esri, Wayback, Google, ...) is matched against the drone
image on the same EPSG:3857 grid. Per reference, a similarity transform is
fitted to the confident matches with RANSAC; the transform moves every pixel of
the drone footprint to where the reference shows it, so the geodesic length of
that move is the georeferencing offset. A reference only counts ("qualifies")
when the fit is backed by enough well-spread inliers and its Good/Poor call
survives leaving out each image quadrant in turn. It may decide the dataset
when its inliers support at least RULES.min_support of the footprint.

The dataset call: qualified, deciding references that agree decide; opposite
calls, or a reference whose call flips under a holdout, leave it uncertain.
Pure numpy/OpenCV; no I/O. Ported from the georeferencing research matcher
(combined_assessment.py, rules audit-retention-v3) without its audit-retention
fallback, which read the audit label.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

import cv2
import numpy as np
from pyproj import Geod, Transformer
from scipy.spatial import cKDTree

RULES_VERSION = 'georef-rules-v1'


@dataclass(frozen=True)
class Rules:
	threshold_m: float = 15.0  # the audit's Good/Poor boundary
	min_score: float = 0.5  # matcher confidence of a usable match
	min_matches: int = 20  # confident matches needed to try a fit
	ransac_m: float = 5.0  # RANSAC reprojection threshold and inlier residual
	min_inliers: int = 100
	min_inlier_fraction: float = 0.5
	min_cells: int = 4  # occupied cells of a 4x4 grid over the footprint
	min_holdouts: int = 2  # quadrant holdouts that must agree
	min_support: float = 0.30  # supported fraction of the footprint to decide
	near_match: float = 0.12  # footprint pixel within this image-diagonal fraction of an inlier
	# strong evidence: independent groups, broad support, clear of the boundary
	strong_groups: int = 2
	strong_support: float = 0.8
	strong_margin_m: float = 3.0


RULES = Rules()
_GEOD = Geod(ellps='WGS84')
_TO_LONLAT = Transformer.from_crs('EPSG:3857', 'EPSG:4326', always_xy=True)


@dataclass(frozen=True)
class Grid:
	"""The shared EPSG:3857 pixel grid of drone and reference images."""

	bounds: tuple[float, float, float, float]  # left, bottom, right, top
	width: int
	height: int

	@property
	def res(self) -> float:
		return (self.bounds[2] - self.bounds[0]) / self.width

	def lonlat(self, px: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
		left, _, _, top = self.bounds
		x = left + (px[:, 0] + 0.5) * self.res
		y = top - (px[:, 1] + 0.5) * (self.bounds[3] - self.bounds[1]) / self.height
		return _TO_LONLAT.transform(x, y)

	def metres_per_pixel(self) -> float:
		centre = np.array([[self.width / 2, self.height / 2], [self.width / 2 + 1, self.height / 2]])
		lon, lat = self.lonlat(centre)
		return float(_GEOD.inv(lon[0], lat[0], lon[1], lat[1])[2])


def offsets_m(a: np.ndarray, b: np.ndarray, grid: Grid) -> np.ndarray:
	"""Geodesic distance (m) between pixel positions a and b."""
	if not len(a):
		return np.zeros(0)
	lon_a, lat_a = grid.lonlat(a)
	lon_b, lat_b = grid.lonlat(b)
	return np.asarray(_GEOD.inv(lon_a, lat_a, lon_b, lat_b)[2])


def source_family(provider: str) -> str:
	"""Evidence group of a reference: same-family imagery is not independent."""
	return 'esri' if provider.startswith('wayback') or provider == 'esri' else provider


@dataclass
class ReferenceEvidence:
	provider: str
	group: str
	matches: int = 0  # confident matches
	inliers: int = 0
	inlier_fraction: float = 0.0
	cells: int = 0
	support: float = 0.0  # supported fraction of the footprint
	edge_support: float = 0.0  # supported fraction of the footprint's edge band
	p50_m: float | None = None
	p90_m: float | None = None
	holdout_p90_m: list[float] = field(default_factory=list)
	vote: str | None = None  # good / poor / unstable
	qualified: bool = False
	decides: bool = False
	reason: str | None = None  # why it does not qualify or decide
	matrix: list[list[float]] | None = None
	sample_pairs: list[list[float]] = field(default_factory=list)  # [x_src, y_src, x_ref, y_ref] pixels

	def as_dict(self) -> dict:
		return asdict(self)


def _fit(a: np.ndarray, b: np.ndarray, grid: Grid, rules: Rules):
	cv2.setRNGSeed(0)
	return cv2.estimateAffinePartial2D(
		a.astype(np.float32),
		b.astype(np.float32),
		method=cv2.RANSAC,
		ransacReprojThreshold=rules.ransac_m / grid.metres_per_pixel(),
		maxIters=10000,
		confidence=0.995,
		refineIters=20,
	)


def _apply(matrix: np.ndarray, px: np.ndarray) -> np.ndarray:
	return px @ matrix[:, :2].T + matrix[:, 2]


def _vote(p90s: list[float], rules: Rules) -> str:
	classes = {'good' if v < rules.threshold_m else 'poor' for v in p90s}
	return classes.pop() if len(classes) == 1 else 'unstable'


def measure_reference(
	provider: str,
	a: np.ndarray,
	b: np.ndarray,
	scores: np.ndarray,
	footprint: np.ndarray,
	edge: np.ndarray,
	grid: Grid,
	rules: Rules = RULES,
) -> ReferenceEvidence:
	"""Evidence of one reference. `a`/`b` are matched drone/reference pixels,
	`footprint` the (N, 2) sampled footprint pixels, `edge` marks its edge band."""
	e = ReferenceEvidence(provider=provider, group=source_family(provider))
	strong = scores >= rules.min_score
	a, b = a[strong], b[strong]
	e.matches = int(len(a))
	if e.matches < rules.min_matches or not len(footprint):
		e.reason = 'no_fit'
		return e
	matrix, ransac = _fit(a, b, grid, rules)
	if matrix is None:
		e.reason = 'no_fit'
		return e
	residual = offsets_m(_apply(matrix, a), b, grid)
	inliers = ransac[:, 0].astype(bool) & (residual <= rules.ransac_m)
	anchors = a[inliers]
	e.inliers = int(inliers.sum())
	e.inlier_fraction = round(float(inliers.mean()), 3)
	cols = np.clip((anchors[:, 0] / grid.width * 4).astype(int), 0, 3)
	rows = np.clip((anchors[:, 1] / grid.height * 4).astype(int), 0, 3)
	e.cells = len(set(zip(cols.tolist(), rows.tolist())))
	e.matrix = np.round(matrix, 6).tolist()
	if e.inliers < rules.min_inliers:
		e.reason = 'few_inliers'
		return e
	if e.inlier_fraction < rules.min_inlier_fraction:
		e.reason = 'inconsistent_matches'
		return e
	if e.cells < rules.min_cells:
		e.reason = 'clustered_matches'
		return e

	# footprint pixels inside the inliers' hull and near an inlier are supported
	hull = cv2.convexHull(anchors.astype(np.float32)).astype(np.float32)
	inside = np.array([cv2.pointPolygonTest(hull, (float(x), float(y)), False) >= 0 for x, y in footprint])
	near = cKDTree(anchors).query(footprint)[0] <= rules.near_match * np.hypot(grid.width, grid.height)
	supported = inside & near
	e.support = round(float(supported.mean()), 3)
	e.edge_support = round(float(supported[edge].mean()), 3) if edge.any() else 0.0
	if not supported.any():
		e.reason = 'no_support'
		return e
	distance = offsets_m(footprint[supported], _apply(matrix, footprint[supported]), grid)
	e.p50_m = round(float(np.median(distance)), 2)
	e.p90_m = round(float(np.quantile(distance, 0.9)), 2)

	# the call must survive refitting without each image quadrant
	quadrant = (a[:, 0] >= grid.width / 2).astype(int) + 2 * (a[:, 1] >= grid.height / 2).astype(int)
	for q in range(4):
		keep = quadrant != q
		if np.sum(inliers & ~keep) < 10 or keep.sum() < 50:
			continue
		alternative, _ = _fit(a[keep], b[keep], grid, rules)
		if alternative is not None:
			moved = offsets_m(footprint[supported], _apply(alternative, footprint[supported]), grid)
			e.holdout_p90_m.append(round(float(np.quantile(moved, 0.9)), 2))
	if len(e.holdout_p90_m) < rules.min_holdouts:
		e.reason = 'too_few_holdouts'
		return e
	e.vote = _vote([e.p90_m, *e.holdout_p90_m], rules)
	e.qualified = True
	e.decides = e.support >= rules.min_support
	if not e.decides:
		e.reason = 'low_support'
	elif e.vote == 'unstable':
		e.reason = 'unstable_near_threshold'

	pick = np.linspace(0, len(anchors) - 1, min(len(anchors), 200)).astype(int)
	e.sample_pairs = np.round(np.column_stack((anchors[pick], b[inliers][pick])), 1).tolist()
	return e


@dataclass
class Assessment:
	decision: str  # good / poor / uncertain
	evidence_level: str  # strong / qualified / insufficient / conflict
	reason: str
	p90_m: float | None  # median over deciding references
	groups: int  # independent evidence groups among deciding references
	support: float  # best support among deciding references
	edge_support: float


def combine(evidence: list[ReferenceEvidence], rules: Rules = RULES) -> Assessment:
	deciding = [e for e in evidence if e.decides]
	votes = {e.vote for e in deciding}
	groups = len({e.group for e in deciding})
	support = max((e.support for e in deciding), default=0.0)
	edge = max((e.edge_support for e in deciding), default=0.0)
	p90 = round(float(np.median([e.p90_m for e in deciding])), 2) if deciding else None
	if not deciding:
		return Assessment('uncertain', 'insufficient', 'no_qualified_reference', None, 0, 0.0, 0.0)
	if 'unstable' in votes:
		return Assessment('uncertain', 'conflict', 'unstable_near_threshold', p90, groups, support, edge)
	if votes == {'good', 'poor'}:
		return Assessment('uncertain', 'conflict', 'references_disagree', p90, groups, support, edge)
	decision = votes.pop()
	clear = all(abs(e.p90_m - rules.threshold_m) >= rules.strong_margin_m for e in deciding)
	broad = support >= rules.strong_support and (decision == 'poor' or edge >= rules.strong_support)
	strong = groups >= rules.strong_groups and broad and clear
	return Assessment(decision, 'strong' if strong else 'qualified', 'references_agree', p90, groups, support, edge)


def footprint_samples(mask: np.ndarray, step: int = 8, edge_fraction: float = 0.08):
	"""Sampled footprint pixels (x, y) and which of them lie in the edge band."""
	yy, xx = np.nonzero(mask[::step, ::step])
	pixels = np.column_stack((xx * step, yy * step)).astype(float)
	interior = cv2.distanceTransform(np.pad(mask.astype(np.uint8), 1), cv2.DIST_L2, 5)[1:-1, 1:-1]
	edge = interior[yy * step, xx * step] <= edge_fraction * min(mask.shape)
	return pixels, edge
