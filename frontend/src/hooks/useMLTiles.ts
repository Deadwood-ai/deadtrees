// ============================================================================
// DEPRECATED: This file is kept for backward compatibility.
// Use hooks/useReferencePatches.ts for new code.
// ============================================================================

// Re-export all hooks with old names for backward compatibility
export {
  useReferencePatches as useMLTiles,
  useNestedPatches as useNestedTiles,
  usePatchSessionLock as useTileSessionLock,
  useSetPatchSessionLock as useSetTileSessionLock,
  useClearPatchSessionLock as useClearTileSessionLock,
  useCreateReferencePatch as useCreateMLTile,
  useUpdatePatchStatus as useUpdateTileStatus,
  useUpdatePatchGeometry as useUpdateTileGeometry,
  useDeleteReferencePatch as useDeleteMLTile,
  useGenerateNestedPatches as useGenerateNestedTiles,
  usePatchProgress as useTileProgress,
  useCompletePatchGeneration as useCompleteTileGeneration,
  useReopenPatchGeneration as useReopenTileGeneration,
} from "./useReferencePatches";
