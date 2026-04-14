// ============================================================================
// DEPRECATED: This file is kept for backward compatibility.
// Use types/referencePatches.ts for new code.
// ============================================================================

import type {
  IReferencePatch,
  PatchResolution,
  PatchStatus,
  IPatchSession,
  IPatchGenerationProgress,
  IPatchPlacementDraft,
  IPatchPhaseState,
} from "./referencePatches";

// Re-export new types with old names for backward compatibility
export type TileResolution = PatchResolution;
export type TileStatus = PatchStatus;

// Map patch_index back to tile_index for backward compatibility
export type IMLTile = Omit<IReferencePatch, "patch_index"> & {
  tile_index: string; // Maps to patch_index in DB
};

export type ITileSession = IPatchSession;
export type ITileGenerationProgress = IPatchGenerationProgress;
export type ITilePlacementDraft = IPatchPlacementDraft;
export type ITilePhaseState = IPatchPhaseState;

// Helper to convert between formats
export function referencePatchToMLTile(patch: IReferencePatch): IMLTile {
  const { patch_index, ...rest } = patch;
  return {
    ...rest,
    tile_index: patch_index,
  };
}

export function mlTileToReferencePatch(tile: IMLTile): IReferencePatch {
  const { tile_index, ...rest } = tile;
  return {
    ...rest,
    patch_index: tile_index,
  };
}
