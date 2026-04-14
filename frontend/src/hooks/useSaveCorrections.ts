import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { isTokenExpiringSoon } from "../utils/isTokenExpiringSoon";
import type Feature from "ol/Feature";
import type { Geometry } from "ol/geom";
import MultiPolygon from "ol/geom/MultiPolygon";
import GeoJSON from "ol/format/GeoJSON";

export type LayerType = "deadwood" | "forest_cover";

interface Deletion {
  id: number;
  updated_at: string;
}

interface Addition {
  geometry: object;
  original_geometry_id: number | null;
}

interface SaveCorrectionsParams {
  datasetId: number;
  labelId: number;
  layerType: LayerType;
  deletions: Deletion[];
  additions: Addition[];
}

interface SaveCorrectionsResult {
  success: boolean;
  message: string;
  conflict_ids: number[] | null;
}

interface GeometryRow {
  id: number;
  geometry: object;
  updated_at: string;
  is_deleted: boolean;
}

/**
 * Hook to get the active prediction label for a dataset + layer type
 */
export function usePredictionLabel(datasetId: number | undefined, layerType: LayerType | null) {
  return useQuery({
    queryKey: ["prediction-label", datasetId, layerType],
    queryFn: async () => {
      if (!datasetId || !layerType) return null;

      const { data, error } = await supabase
        .from("v2_labels")
        .select("id")
        .eq("dataset_id", datasetId)
        .eq("label_data", layerType)
        .eq("label_source", "model_prediction")
        .eq("is_active", true)
        .maybeSingle();

      if (error) throw error;
      return data;
    },
    enabled: !!datasetId && !!layerType,
  });
}

/**
 * Hook to load geometries for editing
 * Returns features with geometry_id, updated_at metadata attached
 */
export function useLoadGeometriesForEditing(labelId: number | undefined, layerType: LayerType | null) {
  const geoJson = new GeoJSON();

  return useQuery({
    queryKey: ["geometries-for-editing", labelId, layerType],
    queryFn: async (): Promise<Feature<Geometry>[]> => {
      if (!labelId || !layerType) return [];

      const tableName =
        layerType === "deadwood" ? "v2_deadwood_geometries" : "v2_forest_cover_geometries";

      // Note: correction_status is computed via RPC functions (JOINs with corrections table)
      // It's not a column on the geometry tables, so we don't query for it here
      const { data, error } = await supabase
        .from(tableName)
        .select("id, geometry, updated_at, is_deleted")
        .eq("label_id", labelId)
        .eq("is_deleted", false);

      if (error) throw error;
      if (!data) return [];

      // Dynamically import OpenLayers Feature to avoid SSR issues
      const { default: Feature } = await import("ol/Feature");

      return (data as GeometryRow[]).map((row) => {
        const feature = new Feature(
          geoJson.readGeometry(row.geometry, {
            dataProjection: "EPSG:4326",
            featureProjection: "EPSG:3857",
          })
        );
        // Store DB metadata on feature for save operation
        feature.set("geometry_id", row.id);
        feature.set("updated_at", row.updated_at);
        // correction_status is not available from direct table query - it comes from RPC functions
        // For editing, we track changes via is_new/is_modified instead
        feature.set("is_new", false);
        feature.set("is_modified", false);
        return feature;
      });
    },
    enabled: !!labelId && !!layerType,
    staleTime: 0, // Always refetch when entering edit mode
  });
}

/**
 * Build the save payload by comparing initial and current features
 */
export function buildSavePayload(
  initialFeatures: Feature<Geometry>[],
  currentFeatures: Feature<Geometry>[],
  geoJson: GeoJSON
): { deletions: Deletion[]; additions: Addition[] } {
  // Build a map of initial features by geometry_id for quick lookup
  const initialFeatureMap = new Map<number, Feature<Geometry>>();
  initialFeatures.forEach((f) => {
    const id = f.get("geometry_id") as number;
    if (id) initialFeatureMap.set(id, f);
  });

  const currentIds = new Set(
    currentFeatures
      .filter((f) => !f.get("is_new"))
      .map((f) => f.get("geometry_id") as number)
      .filter(Boolean)
  );

  // Collect IDs that are being replaced by modified features
  // These should NOT be in deletions - the 'modify' operation handles soft-delete on approval
  const replacedIds = new Set<number>();
  currentFeatures.forEach((f) => {
    const replacesId = f.get("replaces_geometry_id") as number;
    if (replacesId) replacedIds.add(replacesId);
  });

  // Deletions: ONLY features explicitly deleted (not in current, not being replaced by modify)
  // Modified features use 'modify' operation which handles soft-delete on approval
  const deletions: Deletion[] = initialFeatures
    .filter((f) => {
      const id = f.get("geometry_id") as number;
      if (!id) return false;
      // Skip if being replaced by a modify - handled by 'modify' operation
      if (replacedIds.has(id)) return false;
      // Only include explicitly deleted (not in current)
      return !currentIds.has(id);
    })
    .map((f) => ({
      id: f.get("geometry_id") as number,
      updated_at: f.get("updated_at") as string,
    }));

  // Additions: new features OR modified features
  // MultiPolygon geometries are decomposed into individual Polygon additions
  // because the DB columns are typed geometry(Polygon, 4326).
  const additions: Addition[] = [];
  for (const f of currentFeatures) {
    if (!f.get("is_new") && !f.get("is_modified")) continue;
    const geom = f.getGeometry()!;
    const originalId = (f.get("replaces_geometry_id") as number) || null;

    if (geom instanceof MultiPolygon) {
      const polys = geom.getPolygons();
      for (let i = 0; i < polys.length; i++) {
        additions.push({
          geometry: geoJson.writeGeometryObject(polys[i], {
            dataProjection: "EPSG:4326",
            featureProjection: "EPSG:3857",
          }),
          original_geometry_id: i === 0 ? originalId : null,
        });
      }
    } else {
      additions.push({
        geometry: geoJson.writeGeometryObject(geom, {
          dataProjection: "EPSG:4326",
          featureProjection: "EPSG:3857",
        }),
        original_geometry_id: originalId,
      });
    }
  }

  return { deletions, additions };
}

/**
 * Hook to save prediction corrections
 */
export function useSaveCorrections() {
  const { user, session } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: SaveCorrectionsParams): Promise<SaveCorrectionsResult> => {
      if (!user?.id) {
        throw new Error("User must be logged in to save corrections");
      }

      // Refresh token if needed — long editing sessions can outlive the access token
      if (isTokenExpiringSoon(session)) {
        const { error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError) {
          throw new Error("Session expired. Please sign in again.");
        }
      }

      const sessionId = crypto.randomUUID();

      const { data, error } = await supabase.rpc("save_prediction_corrections", {
        p_dataset_id: params.datasetId,
        p_label_id: params.labelId,
        p_user_id: user.id,
        p_layer_type: params.layerType,
        p_session_id: sessionId,
        p_deletions: params.deletions.map((d) => d.id),
        p_deletion_timestamps: params.deletions.map((d) => d.updated_at),
        p_additions: params.additions,
      });

      if (error) throw error;
      if (!data) {
        throw new Error("No response from save_prediction_corrections");
      }

      // RPC returns an array with one row
      const result = Array.isArray(data) ? data[0] : data;
      
      // Validate response format
      if (!result || typeof result.success !== "boolean") {
        throw new Error("Unexpected response format from save_prediction_corrections");
      }
      
      return result as SaveCorrectionsResult;
    },
    onSuccess: (_, params) => {
      // Invalidate related queries
      queryClient.invalidateQueries({
        queryKey: ["geometries-for-editing", params.labelId],
      });
      queryClient.invalidateQueries({
        queryKey: ["correction-history", params.datasetId],
      });
    },
  });
}

/**
 * Hook to fetch correction history for a dataset
 */
export function useCorrectionHistory(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["correction-history", datasetId],
    queryFn: async () => {
      if (!datasetId) return [];

      const { data, error } = await supabase
        .from("v2_geometry_corrections")
        .select("*")
        .eq("dataset_id", datasetId)
        .order("created_at", { ascending: false });

      if (error) throw error;
      return data || [];
    },
    enabled: !!datasetId,
  });
}

/**
 * Hook to approve a correction (audit only)
 */
export function useApproveCorrection() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (correctionId: number): Promise<boolean> => {
      if (!user?.id) throw new Error("User must be logged in");

      const { data, error } = await supabase.rpc("approve_correction", {
        p_correction_id: correctionId,
        p_reviewer_id: user.id,
      });

      if (error) throw error;
      return data as boolean;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["correction-history"] });
    },
  });
}

/**
 * Hook to revert a correction (audit only)
 */
export function useRevertCorrection() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (correctionId: number): Promise<boolean> => {
      if (!user?.id) throw new Error("User must be logged in");

      const { data, error } = await supabase.rpc("revert_correction", {
        p_correction_id: correctionId,
        p_reviewer_id: user.id,
      });

      if (error) throw error;
      return data as boolean;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["correction-history"] });
      queryClient.invalidateQueries({ queryKey: ["geometries-for-editing"] });
    },
  });
}
