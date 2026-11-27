import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import { withAuditLease } from "./useAuditLock";
import { AUDIT_RESULTS_KEY } from "./useAuditChecks";
import {
  type ExistingAOI,
  resolveAOIRevisionMetadata,
  resolveAOISaveTarget,
} from "./aoiSaveProvenance";
import { withoutEmptyGeometry } from "../utils/aoiGeometry";

export interface AOIData {
  id?: number;
  dataset_id: number;
  user_id?: string;
  geometry: GeoJSON.MultiPolygon | GeoJSON.Polygon;
  is_whole_image: boolean;
  source?: "ml_prediction" | "manual" | "manual_correction";
  corrected_from_aoi_id?: number | null;
  image_quality?: number | null;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
}

/** The map image's technical metadata (v2_cogs.cog_info, as rio-cogeo reports it). */
export interface CogMetadata {
  dataset_id: number;
  cog_info: Record<string, unknown> | null;
}

type LegacyQuality = "great" | "sentinel_ok" | "bad";

/** A saved manual audit (dataset_audit_legacy, read through the dataset_audit view). Nothing
 * writes these any more; the Audit Review page lists them as read-only history. */
export interface DatasetAuditUserInfo {
  dataset_id: number;
  audit_date: string | null;
  is_georeferenced: boolean | null;
  has_valid_acquisition_date: boolean | null;
  acquisition_date_notes: string | null;
  has_valid_phenology: boolean | null;
  phenology_notes: string | null;
  deadwood_quality: LegacyQuality | null;
  deadwood_notes: string | null;
  forest_cover_quality: LegacyQuality | null;
  forest_cover_notes: string | null;
  aoi_done: boolean | null;
  has_cog_issue: boolean | null;
  cog_issue_notes: string | null;
  has_thumbnail_issue: boolean | null;
  thumbnail_issue_notes: string | null;
  audited_by: string | null;
  audited_by_email: string | null;
  uploaded_by_email: string | null;
  has_major_issue: boolean | null;
  final_assessment: "no_issues" | "fixable_issues" | "exclude_completely" | null;
  notes: string | null;
  // Review workflow fields
  reviewed_at: string | null;
  reviewed_by: string | null;
  reviewed_by_email: string | null;
  accept_suggested_acquisition_date?: boolean | null;
}

/** Every saved manual audit with emails (auditors only), read-only history. */
export function useLegacyDatasetAudits() {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();

  return useQuery({
    queryKey: ["legacy-dataset-audits"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_dataset_audits_with_emails");

      if (error) throw error;
      return (data || []) as DatasetAuditUserInfo[];
    },
    enabled: !!user?.id && canAudit,
  });
}

// Auditor-only: get contributor emails for all datasets
export function useDatasetContributors() {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();

  return useQuery({
    queryKey: ["dataset-contributors"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_dataset_contributors_with_emails");

      if (error) throw error;
      const rows = (data || []) as { dataset_id: number; contributor_email: string | null }[];
      return new Map(rows.map((d) => [d.dataset_id, d.contributor_email || ""]));
    },
    enabled: !!user?.id && canAudit,
  });
}

// Hook to get AOI data for a dataset
export function useDatasetAOI(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["dataset-aoi", datasetId],
    queryFn: async () => {
      if (!datasetId) return null;

      const { data, error } = await supabase
        .from("v2_aois")
        .select("*")
        .eq("dataset_id", datasetId)
        .order("created_at", { ascending: false })
        .limit(1);

      if (error) throw error;

      // Return the first item if it exists, otherwise null
      return data && data.length > 0 ? withoutEmptyGeometry(data[0]) : null;
    },
    enabled: !!datasetId,
  });
}

// Hook to save AOI data (supports both insert and update)
export function useSaveDatasetAOI() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ aoi: aoiData, leaseId }: { aoi: AOIData; leaseId: string }) => {
      if (!user?.id) {
        throw new Error("User must be logged in to save AOI");
      }

      // Check if AOI already exists for this dataset
      const { data: existingAOI, error: existingAOIError } = await supabase
        .from("v2_aois")
        .select("id,user_id,source,corrected_from_aoi_id,image_quality,notes")
        .eq("dataset_id", aoiData.dataset_id)
        .order("created_at", { ascending: false })
        .limit(1);

      if (existingAOIError) throw existingAOIError;

      let result;
      const latestAOI = existingAOI?.[0] as ExistingAOI | undefined;
      const saveTarget = resolveAOISaveTarget(latestAOI, user.id);
      const revisionMetadata = resolveAOIRevisionMetadata(latestAOI, aoiData);
      const updatedAt = new Date().toISOString();

      if (saveTarget.kind === "update") {
        // Authors update their own manual AOI row directly.
        const { data, error } = await withAuditLease(
          supabase
            .from("v2_aois")
            .update({
              geometry: aoiData.geometry,
              is_whole_image: aoiData.is_whole_image,
              ...(aoiData.image_quality !== undefined ? { image_quality: aoiData.image_quality } : {}),
              ...(aoiData.notes !== undefined ? { notes: aoiData.notes } : {}),
              updated_at: updatedAt,
            })
            .eq("id", saveTarget.id),
          leaseId,
        )
          .select()
          .single();

        if (error) throw error;
        result = data;
      } else {
        // Preserve authorship across auditors by inserting a new manual row.
        // Corrections keep pointing to the original ML prediction.
        const { data, error } = await withAuditLease(
          supabase.from("v2_aois").insert({
            dataset_id: aoiData.dataset_id,
            user_id: user.id,
            geometry: aoiData.geometry,
            is_whole_image: aoiData.is_whole_image,
            image_quality: revisionMetadata.image_quality,
            notes: revisionMetadata.notes,
            source: saveTarget.source,
            corrected_from_aoi_id: saveTarget.correctedFromAOIId,
            updated_at: updatedAt,
          }),
          leaseId,
        )
          .select()
          .single();

        if (error) throw error;
        result = data;
      }

      return result;
    },
    onSuccess: (savedAOI, { aoi }) => {
      queryClient.setQueryData(["dataset-aoi", aoi.dataset_id], savedAOI);
      queryClient.invalidateQueries({ queryKey: ["dataset-aoi", aoi.dataset_id] });
      // the review results read whether the dataset has an AOI
      queryClient.invalidateQueries({ queryKey: AUDIT_RESULTS_KEY });
    },
  });
}

/** The dataset's map image metadata (v2_cogs.cog_info), or null before the COG exists. */
export function useCogMetadata(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["cog-metadata", datasetId],
    queryFn: async () => {
      const { data, error } = await supabase.from("v2_cogs").select("dataset_id, cog_info").eq("dataset_id", datasetId!).maybeSingle();
      if (error) throw error;
      return (data as CogMetadata | null) ?? null;
    },
    enabled: !!datasetId,
  });
}
