import type { IReferencePatch } from "../../../types/referencePatches";

export const findBasePatchForPatch = (
  patch: IReferencePatch | null | undefined,
  allPatches: IReferencePatch[],
): IReferencePatch | null => {
  if (!patch) return null;
  if (patch.resolution_cm === 20) return patch;

  // Walk parent links to the root/base patch (20cm).
  let current: IReferencePatch | undefined = patch;
  while (current?.parent_tile_id) {
    const parent = allPatches.find((p) => p.id === current?.parent_tile_id);
    if (!parent) break;
    current = parent;
  }

  if (current?.resolution_cm === 20) return current;

  // Fallback for datasets where parent links are incomplete:
  // resolve base by the first two segments of patch_index (e.g., "12_3" from "12_3_1_2").
  const parts = patch.patch_index.split("_");
  if (parts.length >= 2) {
    const baseIndex = `${parts[0]}_${parts[1]}`;
    const basePatch = allPatches.find((p) => p.resolution_cm === 20 && p.patch_index === baseIndex);
    if (basePatch) return basePatch;
  }

  return allPatches.find((p) => p.resolution_cm === 20) || null;
};

export const getDefaultSelectedPatchId = (patches: IReferencePatch[]): number | null => {
  const patch5cm = patches.find((p) => p.resolution_cm === 5);
  if (patch5cm) return patch5cm.id;

  const basePatch = patches.find((p) => p.resolution_cm === 20);
  return basePatch?.id || null;
};

export const getPreferredDefaultPatch = (patches: IReferencePatch[]): IReferencePatch | null => {
  const pending5cmPatch = patches.find(
    (p) => p.resolution_cm === 5 && (p.deadwood_validated === null || p.forest_cover_validated === null),
  );
  if (pending5cmPatch) return pending5cmPatch;

  const any5cmPatch = patches.find((p) => p.resolution_cm === 5);
  if (any5cmPatch) return any5cmPatch;

  const baseWithReference = patches.find(
    (p) =>
      p.resolution_cm === 20 &&
      (p.reference_deadwood_label_id !== null || p.reference_forest_cover_label_id !== null),
  );
  if (baseWithReference) return baseWithReference;

  return patches.find((p) => p.resolution_cm === 20) || null;
};
