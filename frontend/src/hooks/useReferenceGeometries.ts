import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { ILabel, ILabelData } from "../types/labels";

// Fetch reference geometries for a specific patch and layer
export function useReferenceGeometries(patchId: number | undefined, layerType: ILabelData) {
  return useQuery({
    queryKey: ["reference-geometries", patchId, layerType],
    queryFn: async () => {
      if (!patchId) return [];

      const tableName =
        layerType === "deadwood" ? "reference_patch_deadwood_geometries" : "reference_patch_forest_cover_geometries";

      // First, find the active label for this patch and layer type
      const { data: labelData, error: labelError } = await supabase
        .from("v2_labels")
        .select("id")
        .eq("reference_patch_id", patchId)
        .eq("label_data", layerType)
        .eq("is_active", true)
        .maybeSingle();

      if (labelError) throw labelError;
      if (!labelData) return []; // No reference data yet

      // Fetch geometries for this label
      const { data: geometries, error: geomError } = await supabase
        .from(tableName)
        .select("*")
        .eq("label_id", labelData.id)
        .order("created_at", { ascending: true });

      if (geomError) throw geomError;

      return geometries || [];
    },
    enabled: !!patchId,
  });
}

// Create or update reference label with geometries
// Uses atomic RPC function to prevent race conditions
export function useSaveReferenceGeometries() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({
      patchId,
      datasetId,
      layerType,
      geometries,
    }: {
      patchId: number;
      datasetId: number;
      layerType: ILabelData;
      geometries: unknown[];
    }) => {
      if (!user) throw new Error("User not authenticated");

      // Use atomic RPC function to handle label versioning and geometry insertion
      // This prevents race conditions with the unique constraint
      // Pass geometries directly - Supabase will convert to JSONB automatically
      const { data, error } = await supabase.rpc("save_reference_geometries", {
        p_patch_id: patchId,
        p_dataset_id: datasetId,
        p_user_id: user.id,
        p_layer_type: layerType,
        p_geometries: geometries,
      });

      if (error) throw error;

      // data is an array with one row: [{ label_id, version }]
      const result = data?.[0];
      return {
        newLabelId: result?.label_id,
        version: result?.version,
      };
    },
    onSuccess: (_data, variables) => {
      // Invalidate queries
      queryClient.invalidateQueries({ queryKey: ["reference-geometries", variables.patchId, variables.layerType] });
      queryClient.invalidateQueries({ queryKey: ["reference-patches", variables.datasetId] });
    },
  });
}

// Fetch label version history for revert functionality
export function useLabelVersionHistory(patchId: number | undefined, layerType: ILabelData) {
  return useQuery({
    queryKey: ["label-version-history", patchId, layerType],
    queryFn: async (): Promise<ILabel[]> => {
      if (!patchId) return [];

      const { data, error } = await supabase
        .from("v2_labels")
        .select("*")
        .eq("reference_patch_id", patchId)
        .eq("label_data", layerType)
        .order("version", { ascending: false });

      if (error) throw error;
      return (data || []) as ILabel[];
    },
    enabled: !!patchId,
  });
}

// Revert to a previous version
export function useRevertToVersion() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({
      patchId,
      datasetId,
      layerType,
      targetLabelId,
    }: {
      patchId: number;
      datasetId: number;
      layerType: ILabelData;
      targetLabelId: number;
    }) => {
      if (!user) throw new Error("User not authenticated");

      const tableName =
        layerType === "deadwood" ? "reference_patch_deadwood_geometries" : "reference_patch_forest_cover_geometries";

      // 1. Mark current active label as inactive
      const { error: deactivateError } = await supabase
        .from("v2_labels")
        .update({ is_active: false })
        .eq("reference_patch_id", patchId)
        .eq("label_data", layerType)
        .eq("is_active", true);

      if (deactivateError) throw deactivateError;

      // 2. Get target label details and max version
      const { data: targetLabel, error: targetError } = await supabase
        .from("v2_labels")
        .select("version")
        .eq("id", targetLabelId)
        .single();

      if (targetError) throw targetError;

      const { data: maxVersionData, error: maxVersionError } = await supabase
        .from("v2_labels")
        .select("version")
        .eq("reference_patch_id", patchId)
        .eq("label_data", layerType)
        .order("version", { ascending: false })
        .limit(1)
        .single();

      if (maxVersionError) throw maxVersionError;

      // 3. Create new label pointing to target version
      const { data: newLabel, error: newLabelError } = await supabase
        .from("v2_labels")
        .insert({
          dataset_id: datasetId,
          user_id: user.id,
          label_data: layerType,
          label_type: "semantic_segmentation",
          label_source: "reference_patch",
          reference_patch_id: patchId,
          version: maxVersionData.version + 1,
          parent_label_id: targetLabelId,
          is_active: true,
        })
        .select("id")
        .single();

      if (newLabelError) throw newLabelError;

      // 4. Clone geometries from target version
      const { data: targetGeometries, error: fetchError } = await supabase
        .from(tableName)
        .select("geometry, area_m2, properties")
        .eq("label_id", targetLabelId);

      if (fetchError) throw fetchError;

      if (targetGeometries && targetGeometries.length > 0) {
        const clonedGeometries = targetGeometries.map((g) => ({
          label_id: newLabel.id,
          patch_id: patchId,
          geometry: g.geometry,
          area_m2: g.area_m2,
          properties: g.properties,
        }));

        const { error: insertError } = await supabase.from(tableName).insert(clonedGeometries);

        if (insertError) throw insertError;
      }

      // 5. Update patch's reference label ID and updated_at timestamp
      const patchColumnName =
        layerType === "deadwood" ? "reference_deadwood_label_id" : "reference_forest_cover_label_id";

      const { error: patchUpdateError } = await supabase
        .from("reference_patches")
        .update({
          [patchColumnName]: newLabel.id,
          updated_at: new Date().toISOString(),
        })
        .eq("id", patchId);

      if (patchUpdateError) throw patchUpdateError;

      return { newLabelId: newLabel.id, revertedToVersion: targetLabel.version };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["reference-geometries", variables.patchId, variables.layerType] });
      queryClient.invalidateQueries({ queryKey: ["label-version-history", variables.patchId, variables.layerType] });
      queryClient.invalidateQueries({ queryKey: ["reference-patches", variables.datasetId] });
    },
  });
}
