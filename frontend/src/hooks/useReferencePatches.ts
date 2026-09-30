import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import {
  IReferencePatch,
  PatchResolution,
  PatchStatus,
  IPatchSession,
  IPatchGenerationProgress,
} from "../types/referencePatches";

export type ReferencePatchCreateInput = Omit<
  IReferencePatch,
  "id" | "created_at" | "updated_at" | "user_id" | "status" | "utm_zone" | "epsg_code"
> & {
  status?: PatchStatus;
  utm_zone?: string | null;
  epsg_code?: number | null;
};

const getPatchStatus = (patch: Partial<IReferencePatch> & { status?: PatchStatus | null }): PatchStatus => {
  if (patch.status) return patch.status;
  if (patch.deadwood_validated === false || patch.forest_cover_validated === false) return "bad";
  if (patch.deadwood_validated === true && patch.forest_cover_validated === true) return "good";
  return "pending";
};

const normalizeReferencePatch = (patch: unknown): IReferencePatch => {
  const normalized = patch as IReferencePatch;
  return {
    ...normalized,
    status: getPatchStatus(normalized),
    deadwood_validated: normalized.deadwood_validated ?? null,
    forest_cover_validated: normalized.forest_cover_validated ?? null,
  };
};

// Fetch all patches for a dataset
export function useReferencePatches(datasetId: number | undefined, resolution?: PatchResolution) {
  return useQuery({
    queryKey: ["reference-patches", datasetId, resolution],
    queryFn: async (): Promise<IReferencePatch[]> => {
      if (!datasetId) return [];

      let query = supabase.from("reference_patches").select("*").eq("dataset_id", datasetId);

      if (resolution) {
        query = query.eq("resolution_cm", resolution);
      }

      const { data, error } = await query.order("patch_index");

      if (error) throw error;
      return (data || []).map(normalizeReferencePatch);
    },
    enabled: !!datasetId,
  });
}

// Fetch patches by parent
export function useNestedPatches(parentPatchId: number | undefined) {
  return useQuery({
    queryKey: ["reference-patches", "nested", parentPatchId],
    queryFn: async (): Promise<IReferencePatch[]> => {
      if (!parentPatchId) return [];

      const { data, error } = await supabase
        .from("reference_patches")
        .select("*")
        .eq("parent_tile_id", parentPatchId) // Note: DB column still named parent_tile_id
        .order("patch_index");

      if (error) throw error;
      return (data || []).map(normalizeReferencePatch);
    },
    enabled: !!parentPatchId,
  });
}

// Check session lock
export function usePatchSessionLock(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["patch-session-lock", datasetId],
    queryFn: async (): Promise<IPatchSession | null> => {
      if (!datasetId) return null;

      const { data, error } = await supabase
        .from("v2_statuses")
        .select("is_in_tile_generation, tile_generation_locked_by, tile_generation_locked_at")
        .eq("dataset_id", datasetId)
        .single();

      if (error) throw error;

      return {
        dataset_id: datasetId,
        is_locked: (data as { is_in_tile_generation?: boolean }).is_in_tile_generation || false,
        locked_by: (data as { tile_generation_locked_by?: string }).tile_generation_locked_by || null,
        locked_at: (data as { tile_generation_locked_at?: string }).tile_generation_locked_at || null,
      };
    },
    enabled: !!datasetId,
  });
}

// Set session lock
export function useSetPatchSessionLock() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (datasetId: number) => {
      const { data: existing, error: selectErr } = await supabase
        .from("v2_statuses")
        .select("id")
        .eq("dataset_id", datasetId)
        .maybeSingle();
      if (selectErr) throw selectErr;

      if (!existing) {
        const { error: insertErr } = await supabase
          .from("v2_statuses")
          .insert({ id: datasetId, dataset_id: datasetId });
        if (insertErr) {
          const message = String(insertErr.message || "");
          const isUnique = message.toLowerCase().includes("duplicate") || message.toLowerCase().includes("unique");
          if (!isUnique) throw insertErr;
        }
      }

      const { data, error } = await supabase
        .from("v2_statuses")
        .update({
          is_in_tile_generation: true,
          tile_generation_locked_by: user?.id,
          tile_generation_locked_at: new Date().toISOString(),
        })
        .eq("dataset_id", datasetId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, datasetId) => {
      queryClient.invalidateQueries({ queryKey: ["patch-session-lock", datasetId] });
    },
  });
}

// Clear session lock
export function useClearPatchSessionLock() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (datasetId: number) => {
      const { data, error } = await supabase
        .from("v2_statuses")
        .update({
          is_in_tile_generation: false,
          tile_generation_locked_by: null,
          tile_generation_locked_at: null,
        })
        .eq("dataset_id", datasetId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, datasetId) => {
      queryClient.invalidateQueries({ queryKey: ["patch-session-lock", datasetId] });
    },
  });
}

// Create a new patch
export function useCreateReferencePatch() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (patch: ReferencePatchCreateInput) => {
      const { data, error } = await supabase
        .from("reference_patches")
        .insert({
          ...patch,
          user_id: user?.id,
        })
        .select()
        .single();

      if (error) throw error;
      return normalizeReferencePatch(data);
    },
    onSuccess: (data) => {
      const datasetId = (data as IReferencePatch).dataset_id;
      queryClient.invalidateQueries({ queryKey: ["reference-patches", datasetId] });
      queryClient.invalidateQueries({ queryKey: ["patch-progress", datasetId] });
    },
  });
}

export type PatchValidationLayer = "deadwood" | "forest_cover";

export const ALL_PATCH_LAYERS: PatchValidationLayer[] = ["deadwood", "forest_cover"];

// A whole-patch status stands for the same validation on every layer.
export const patchStatusValidation = (status: PatchStatus): boolean | null =>
  status === "good" ? true : status === "bad" ? false : null;

export interface IPatchValidationInput {
  patchId: number;
  layers: PatchValidationLayer[];
  validated: boolean | null; // null = pending
}

// Set a patch's validation for the given layers. The database recomputes the
// parent and grandparent patches in the same transaction.
export async function setReferencePatchValidation({
  patchId,
  layers,
  validated,
}: IPatchValidationInput): Promise<IReferencePatch> {
  const { data, error } = await supabase.rpc("set_reference_patch_validation", {
    p_patch_id: patchId,
    p_layers: layers,
    p_value: validated,
  });

  if (error) throw error;
  return normalizeReferencePatch(data);
}

export function useSetPatchValidation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: setReferencePatchValidation,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["reference-patches", data.dataset_id] });
      queryClient.invalidateQueries({ queryKey: ["patch-progress", data.dataset_id] });
    },
  });
}

// Update patch geometry and bbox
export function useUpdatePatchGeometry() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      patchId,
      geometry,
      bbox,
      aoiCoveragePercent,
    }: {
      patchId: number;
      geometry: GeoJSON.Polygon;
      bbox: { minx: number; miny: number; maxx: number; maxy: number };
      aoiCoveragePercent?: number | null;
    }) => {
      const { data, error } = await supabase
        .from("reference_patches")
        .update({
          geometry,
          bbox_minx: bbox.minx,
          bbox_miny: bbox.miny,
          bbox_maxx: bbox.maxx,
          bbox_maxy: bbox.maxy,
          aoi_coverage_percent: aoiCoveragePercent ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", patchId)
        .select()
        .single();

      if (error) throw error;
      return normalizeReferencePatch(data);
    },
    onSuccess: (data) => {
      const datasetId = (data as IReferencePatch).dataset_id;
      queryClient.invalidateQueries({ queryKey: ["reference-patches", datasetId] });
      queryClient.invalidateQueries({ queryKey: ["patch-progress", datasetId] });
    },
  });
}

// Delete a patch (and its children via CASCADE)
export function useDeleteReferencePatch() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ patchId, datasetId }: { patchId: number; datasetId: number }) => {
      const { error } = await supabase.from("reference_patches").delete().eq("id", patchId);

      if (error) throw error;
      return datasetId;
    },
    onSuccess: (datasetId) => {
      queryClient.invalidateQueries({ queryKey: ["reference-patches", datasetId] });
      queryClient.invalidateQueries({ queryKey: ["patch-progress", datasetId] });
    },
  });
}

// Generate nested patches (10cm from 20cm, or 5cm from 10cm)
export function useGenerateNestedPatches() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (parentPatch: IReferencePatch) => {
      const childResolution: PatchResolution = parentPatch.resolution_cm === 20 ? 10 : 5;
      const childPatches: ReferencePatchCreateInput[] = [];

      const { bbox_minx, bbox_miny, bbox_maxx, bbox_maxy } = parentPatch;
      const midX = (bbox_minx + bbox_maxx) / 2;
      const midY = (bbox_miny + bbox_maxy) / 2;

      const quadrants = [
        { minx: bbox_minx, miny: midY, maxx: midX, maxy: bbox_maxy, idx: 0 }, // Top-left
        { minx: midX, miny: midY, maxx: bbox_maxx, maxy: bbox_maxy, idx: 1 }, // Top-right
        { minx: bbox_minx, miny: bbox_miny, maxx: midX, maxy: midY, idx: 2 }, // Bottom-left
        { minx: midX, miny: bbox_miny, maxx: bbox_maxx, maxy: midY, idx: 3 }, // Bottom-right
      ] as const;

      for (const quad of quadrants) {
        const geometry: GeoJSON.Polygon = {
          type: "Polygon",
          coordinates: [
            [
              [quad.minx, quad.miny],
              [quad.maxx, quad.miny],
              [quad.maxx, quad.maxy],
              [quad.minx, quad.maxy],
              [quad.minx, quad.miny],
            ],
          ],
        };

        childPatches.push({
          dataset_id: parentPatch.dataset_id,
          resolution_cm: childResolution,
          geometry,
          parent_tile_id: parentPatch.id, // Note: DB column still named parent_tile_id
          patch_index: `${parentPatch.patch_index}_${quad.idx}`,
          utm_zone: parentPatch.utm_zone,
          epsg_code: parentPatch.epsg_code,
          bbox_minx: quad.minx,
          bbox_miny: quad.miny,
          bbox_maxx: quad.maxx,
          bbox_maxy: quad.maxy,
          aoi_coverage_percent: null,
          deadwood_prediction_coverage_percent: null,
          forest_cover_prediction_coverage_percent: null,
          reference_deadwood_label_id: null,
          reference_forest_cover_label_id: null,
          deadwood_validated: null,
          forest_cover_validated: null,
        });
      }

      const { data, error } = await supabase
        .from("reference_patches")
        .insert(childPatches.map((p) => ({ ...p, user_id: user?.id })))
        .select();

      if (error) throw error;
      return (data || []).map(normalizeReferencePatch);
    },
    onSuccess: (_data, parentPatch) => {
      const datasetId = parentPatch.dataset_id;
      const parentId = parentPatch.id;
      queryClient.invalidateQueries({ queryKey: ["reference-patches", datasetId] });
      queryClient.invalidateQueries({ queryKey: ["reference-patches", "nested", parentId] });
      queryClient.invalidateQueries({ queryKey: ["patch-progress", datasetId] });
    },
  });
}

// Get progress summary
export function usePatchProgress(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["patch-progress", datasetId],
    queryFn: async (): Promise<IPatchGenerationProgress | null> => {
      if (!datasetId) return null;

      const { data, error } = await supabase
        .from("reference_patches")
        .select("resolution_cm, deadwood_validated, forest_cover_validated")
        .eq("dataset_id", datasetId);

      if (error) throw error;
      if (!data) return null;

      const patches = data as unknown as Pick<
        IReferencePatch,
        "resolution_cm" | "deadwood_validated" | "forest_cover_validated"
      >[];

      const patches5cm = patches.filter((p) => p.resolution_cm === 5);
      const patches10cm = patches.filter((p) => p.resolution_cm === 10);
      const patches20cm = patches.filter((p) => p.resolution_cm === 20);

      const progress: IPatchGenerationProgress = {
        dataset_id: datasetId,
        // 20cm base patches
        total_20cm: patches20cm.length,
        completed_20cm: patches20cm.filter((p) => p.deadwood_validated !== null || p.forest_cover_validated !== null)
          .length,
        // 10cm patches (auto-validated based on children)
        total_10cm: patches10cm.length,
        good_10cm: patches10cm.filter((p) => p.deadwood_validated === true && p.forest_cover_validated === true).length,
        bad_10cm: patches10cm.filter((p) => p.deadwood_validated === false || p.forest_cover_validated === false)
          .length,
        pending_10cm: patches10cm.filter((p) => p.deadwood_validated === null || p.forest_cover_validated === null)
          .length,
        // 5cm patches - legacy combined view
        total_5cm: patches5cm.length,
        good_5cm: patches5cm.filter((p) => p.deadwood_validated === true && p.forest_cover_validated === true).length,
        bad_5cm: patches5cm.filter((p) => p.deadwood_validated === false || p.forest_cover_validated === false).length,
        pending_5cm: patches5cm.filter((p) => p.deadwood_validated === null || p.forest_cover_validated === null)
          .length,
        // Layer-specific validation for 5cm patches
        deadwood_validated_5cm: patches5cm.filter((p) => p.deadwood_validated !== null).length,
        deadwood_good_5cm: patches5cm.filter((p) => p.deadwood_validated === true).length,
        deadwood_bad_5cm: patches5cm.filter((p) => p.deadwood_validated === false).length,
        deadwood_pending_5cm: patches5cm.filter((p) => p.deadwood_validated === null).length,
        forest_cover_validated_5cm: patches5cm.filter((p) => p.forest_cover_validated !== null).length,
        forest_cover_good_5cm: patches5cm.filter((p) => p.forest_cover_validated === true).length,
        forest_cover_bad_5cm: patches5cm.filter((p) => p.forest_cover_validated === false).length,
        forest_cover_pending_5cm: patches5cm.filter((p) => p.forest_cover_validated === null).length,
      };

      return progress;
    },
    enabled: !!datasetId,
  });
}

// Mark dataset as patch generation complete
export function useCompletePatchGeneration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (datasetId: number) => {
      const { data, error } = await supabase
        .from("v2_statuses")
        .update({
          has_ml_tiles: true,
          ml_tiles_completed_at: new Date().toISOString(),
          is_in_tile_generation: false,
          tile_generation_locked_by: null,
          tile_generation_locked_at: null,
        })
        .eq("dataset_id", datasetId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: async (_data, datasetId) => {
      await queryClient.invalidateQueries({ queryKey: ["datasets"] });
      await queryClient.invalidateQueries({ queryKey: ["dataset-by-id", datasetId] });
      await queryClient.invalidateQueries({ queryKey: ["patch-session-lock", datasetId] });
      await queryClient.invalidateQueries({ queryKey: ["userDatasets"] });
      await queryClient.invalidateQueries({ queryKey: ["public-datasets"] });
      await queryClient.refetchQueries({ queryKey: ["datasets"] });
    },
  });
}

// Reopen dataset for editing (clears completion flag)
export function useReopenPatchGeneration() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (datasetId: number) => {
      const { data, error } = await supabase
        .from("v2_statuses")
        .update({
          has_ml_tiles: false,
          ml_tiles_completed_at: null,
        })
        .eq("dataset_id", datasetId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: async (_data, datasetId) => {
      await queryClient.invalidateQueries({ queryKey: ["datasets"] });
      await queryClient.invalidateQueries({ queryKey: ["dataset-by-id", datasetId] });
      await queryClient.invalidateQueries({ queryKey: ["userDatasets"] });
      await queryClient.invalidateQueries({ queryKey: ["public-datasets"] });
      await queryClient.refetchQueries({ queryKey: ["datasets"] });
    },
  });
}

// Check if dataset is in reference_datasets and get validation status
export type ReferenceDatasetStatus = "pending" | "ready" | null;

export function useReferenceDatasetStatus(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["reference-dataset-status", datasetId],
    queryFn: async (): Promise<ReferenceDatasetStatus> => {
      if (!datasetId) return null;

      // Check if dataset is in reference_datasets table
      const { data: refDataset, error: refError } = await supabase
        .from("reference_datasets")
        .select("id")
        .eq("dataset_id", datasetId)
        .maybeSingle();

      if (refError) throw refError;
      if (!refDataset) return null; // Not a reference dataset

      // Dataset is in reference_datasets, now check if all 5cm patches are validated
      const { data: patches, error: patchError } = await supabase
        .from("reference_patches")
        .select("resolution_cm, deadwood_validated, forest_cover_validated")
        .eq("dataset_id", datasetId)
        .eq("resolution_cm", 5);

      if (patchError) throw patchError;

      // If no 5cm patches exist, it's pending
      if (!patches || patches.length === 0) return "pending";

      // Check if all 5cm patches have both layers validated
      const allValidated = patches.every(
        (p: { deadwood_validated: boolean | null; forest_cover_validated: boolean | null }) =>
          p.deadwood_validated !== null && p.forest_cover_validated !== null,
      );

      return allValidated ? "ready" : "pending";
    },
    enabled: !!datasetId,
  });
}

// Get all dataset IDs that are in reference_datasets table
export function useReferenceDatasetIds() {
  return useQuery({
    queryKey: ["reference-dataset-ids"],
    queryFn: async (): Promise<Set<number>> => {
      const { data, error } = await supabase.from("reference_datasets").select("dataset_id");

      if (error) throw error;

      // Return as a Set for O(1) lookup performance
      return new Set((data || []).map((row: { dataset_id: number }) => row.dataset_id));
    },
  });
}
