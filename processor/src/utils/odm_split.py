"""Render a large mission's orthophoto in overlapping pieces with ODM's split-merge (DT-1491).

ODM textures the whole mesh of a mission at once. Above about 4 km² that runs out of the
ODM container's 100 GB in texrecon (datasets 8463, 8935, 8936, 9212 and 9251, DT-1335),
while pass 1, the reconstruction, still fits. Such a mission therefore keeps its single
pass-1 reconstruction and oblique filter; only the orthophoto pass is split. The kept
shots are cut into pieces of about ``ODM_SPLIT_TARGET_AREA_KM2`` (odm_split_submodels.py),
ODM meshes, textures and renders each piece in turn and merges the piece orthophotos
along cutlines with feathered edges. All pieces share the mission's frame, so ODM's
submodel alignment is skipped.

ODM drops a piece that produced no orthophoto and still merges the rest; a mission with
a hole must fail instead (``missing_piece_orthophotos``).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from processor.src.utils.ortho_resolution import MissionExtent
from processor.src.utils.shared_volume import path_exists_on_shared_volume

# Per-piece outputs ODM's merge stage needs (stages/splitmerge.py, ODMMergeStage).
PIECE_ORTHOPHOTOS = ('odm_orthophoto/odm_orthophoto_feathered.tif', 'odm_orthophoto/odm_orthophoto_cut.tif')
# Matches MIN_PIECE_SHOTS in odm_split_submodels.py.
MIN_PIECE_SHOTS = 3


@dataclass(frozen=True)
class SplitPlan:
	area_km2: float
	pieces: int
	shots_per_piece: int


def plan_split(extent: MissionExtent, shot_count: int, min_area_km2: float, target_area_km2: float) -> SplitPlan | None:
	"""Pieces for a mission whose extent exceeds ``min_area_km2``, or None to render it whole."""
	area_km2 = extent.width_m * extent.height_m / 1e6
	if area_km2 <= min_area_km2:
		return None
	pieces = min(math.ceil(area_km2 / target_area_km2), shot_count // MIN_PIECE_SHOTS)
	if pieces < 2:
		return None
	return SplitPlan(area_km2=area_km2, pieces=pieces, shots_per_piece=math.ceil(shot_count / pieces))


def split_odm_command(odm_command: list[str], plan: SplitPlan, overlap_m: float) -> list[str]:
	"""``odm_command`` with ODM's split-merge on for the submodels odm_split_submodels.py prepared.

	ODM only enters split-merge when the mission has more images than ``--split``; it then
	finds the submodels already there and does not cluster again, so the value only has
	to stay below the image count.
	"""
	return ['--split', str(plan.shots_per_piece), '--split-overlap', f'{overlap_m:g}', '--sm-no-align', *odm_command]


def submodel_name(index: int) -> str:
	return f'submodel_{index:04d}'


def missing_piece_orthophotos(volume_name: str, project_name: str, plan: SplitPlan, dataset_id: int) -> list[str]:
	"""Submodels that ODM's merge had no orthophoto and cutline for."""
	return [
		submodel_name(index)
		for index in range(plan.pieces)
		if not all(
			path_exists_on_shared_volume(volume_name, f'{project_name}/submodels/{submodel_name(index)}/{path}', dataset_id)
			for path in PIECE_ORTHOPHOTOS
		)
	]
