// ============================================================================
// DEPRECATED: This file is kept for backward compatibility.
// Use hooks/useReferencePatches.ts for new code.
// ============================================================================

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ReferencePatchCreateInput,
  useClearPatchSessionLock,
  useCompletePatchGeneration,
  useCreateReferencePatch,
  useDeleteReferencePatch,
  useGenerateNestedPatches,
  useNestedPatches,
  usePatchProgress,
  usePatchSessionLock,
  useReferencePatches,
  useReopenPatchGeneration,
  useSetPatchSessionLock,
  useSetPatchValidation,
  useUpdatePatchGeometry,
  ALL_PATCH_LAYERS,
  patchStatusValidation,
} from "./useReferencePatches";
import { IMLTile, mlTileToReferencePatch, referencePatchToMLTile, TileStatus } from "../types/mlTiles";

type CreateMLTileInput = Omit<
  Partial<IMLTile> &
    Pick<
      IMLTile,
      | "dataset_id"
      | "resolution_cm"
      | "geometry"
      | "parent_tile_id"
      | "tile_index"
      | "bbox_minx"
      | "bbox_miny"
      | "bbox_maxx"
      | "bbox_maxy"
      | "aoi_coverage_percent"
      | "deadwood_prediction_coverage_percent"
      | "forest_cover_prediction_coverage_percent"
    >,
  "id" | "created_at" | "updated_at" | "user_id" | "patch_index"
>;

export {
  usePatchSessionLock as useTileSessionLock,
  useSetPatchSessionLock as useSetTileSessionLock,
  useClearPatchSessionLock as useClearTileSessionLock,
  usePatchProgress as useTileProgress,
  useCompletePatchGeneration as useCompleteTileGeneration,
  useReopenPatchGeneration as useReopenTileGeneration,
};

const normalizeTileInput = (tile: CreateMLTileInput): ReferencePatchCreateInput => {
  const { tile_index, ...tilePayload } = tile;

  return {
    ...tilePayload,
    patch_index: tile_index,
    status: tilePayload.status ?? "pending",
    deadwood_validated: tilePayload.deadwood_validated ?? null,
    forest_cover_validated: tilePayload.forest_cover_validated ?? null,
  };
};

export function useMLTiles(datasetId: number | undefined, resolution?: IMLTile["resolution_cm"]) {
  const query = useReferencePatches(datasetId, resolution);

  return {
    ...query,
    data: query.data?.map(referencePatchToMLTile),
  };
}

export function useNestedTiles(parentTileId: number | undefined) {
  const query = useNestedPatches(parentTileId);

  return {
    ...query,
    data: query.data?.map(referencePatchToMLTile),
  };
}

export function useCreateMLTile() {
  const mutation = useCreateReferencePatch();

  return {
    ...mutation,
    mutate: (
      tile: CreateMLTileInput,
      options?: Parameters<typeof mutation.mutate>[1],
    ) => mutation.mutate(normalizeTileInput(tile), options),
    mutateAsync: async (
      tile: CreateMLTileInput,
      options?: Parameters<typeof mutation.mutateAsync>[1],
    ) => referencePatchToMLTile(await mutation.mutateAsync(normalizeTileInput(tile), options)),
  };
}

export function useUpdateTileStatus() {
  const mutation = useSetPatchValidation();
  const toValidation = ({ tileId, status }: { tileId: number; status: TileStatus }) => ({
    patchId: tileId,
    layers: ALL_PATCH_LAYERS,
    validated: patchStatusValidation(status),
  });

  return {
    ...mutation,
    mutate: (
      variables: { tileId: number; status: TileStatus },
      options?: Parameters<typeof mutation.mutate>[1],
    ) => mutation.mutate(toValidation(variables), options),
    mutateAsync: async (
      variables: { tileId: number; status: TileStatus },
      options?: Parameters<typeof mutation.mutateAsync>[1],
    ) => referencePatchToMLTile(await mutation.mutateAsync(toValidation(variables), options)),
  };
}

export function useUpdateTileGeometry() {
  const mutation = useUpdatePatchGeometry();

  return {
    ...mutation,
    mutate: (
      variables: Parameters<typeof mutation.mutate>[0] extends infer T
        ? Omit<T, "patchId"> & { tileId: number }
        : never,
      options?: Parameters<typeof mutation.mutate>[1],
    ) => {
      const { tileId, ...rest } = variables;
      return mutation.mutate({ ...rest, patchId: tileId }, options);
    },
    mutateAsync: async (
      variables: Parameters<typeof mutation.mutateAsync>[0] extends infer T
        ? Omit<T, "patchId"> & { tileId: number }
        : never,
      options?: Parameters<typeof mutation.mutateAsync>[1],
    ) => {
      const { tileId, ...rest } = variables;
      return referencePatchToMLTile(await mutation.mutateAsync({ ...rest, patchId: tileId }, options));
    },
  };
}

export function useDeleteMLTile() {
  const mutation = useDeleteReferencePatch();

  return {
    ...mutation,
    mutate: (
      variables: { tileId: number; datasetId: number },
      options?: Parameters<typeof mutation.mutate>[1],
    ) => mutation.mutate({ patchId: variables.tileId, datasetId: variables.datasetId }, options),
    mutateAsync: (variables: { tileId: number; datasetId: number }, options?: Parameters<typeof mutation.mutateAsync>[1]) =>
      mutation.mutateAsync({ patchId: variables.tileId, datasetId: variables.datasetId }, options),
  };
}

export function useGenerateNestedTiles() {
  const mutation = useGenerateNestedPatches();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (tile: IMLTile) => {
      const patches = await mutation.mutateAsync(mlTileToReferencePatch(tile));
      return patches.map(referencePatchToMLTile);
    },
    onSuccess: (_data, tile) => {
      queryClient.invalidateQueries({ queryKey: ["reference-patches", tile.dataset_id] });
      queryClient.invalidateQueries({ queryKey: ["reference-patches", "nested", tile.id] });
      queryClient.invalidateQueries({ queryKey: ["patch-progress", tile.dataset_id] });
    },
  });
}
