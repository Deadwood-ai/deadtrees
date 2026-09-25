import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import { useMemo } from "react";
import { withAuditLease } from "./useAuditLock";
import {
  type ExistingAOI,
  resolveAOIRevisionMetadata,
  resolveAOISaveTarget,
} from "./aoiSaveProvenance";

// Update the enum type to match your backend
export type PredictionQuality = "great" | "sentinel_ok" | "bad";

// Simplified disposition enum - 3 levels only
export type DatasetDisposition = "no_issues" | "fixable_issues" | "exclude_completely";

export interface AuditFormValues {
  dataset_id?: number;
  audit_date?: string;
  is_georeferenced?: boolean;
  has_valid_acquisition_date?: boolean;
  acquisition_date_notes?: string;
  has_valid_phenology?: boolean;
  phenology_notes?: string;
  deadwood_quality?: PredictionQuality;
  deadwood_notes?: string;
  forest_cover_quality?: PredictionQuality;
  forest_cover_notes?: string;
  aoi_done?: boolean;
  has_cog_issue?: boolean;
  cog_issue_notes?: string;
  has_thumbnail_issue?: boolean;
  thumbnail_issue_notes?: string;
  audited_by?: string;
  audited_by_email?: string;
  notes?: string;
  // Replace has_major_issue with simplified final assessment
  final_assessment?: DatasetDisposition;
}

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

// New interface for ortho metadata
export interface OrthoMetadata {
  dataset_id: number;
  ortho_info: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

// Public view row for dataset audit info
export interface DatasetAuditUserInfo {
  dataset_id: number;
  audit_date: string | null;
  is_georeferenced: boolean | null;
  has_valid_acquisition_date: boolean | null;
  acquisition_date_notes: string | null;
  has_valid_phenology: boolean | null;
  phenology_notes: string | null;
  deadwood_quality: PredictionQuality | null;
  deadwood_notes: string | null;
  forest_cover_quality: PredictionQuality | null;
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
}

// Auditor-only: get all dataset audits (includes user emails)
export function useDatasetAudits() {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();

  return useQuery({
    queryKey: ["dataset-audits"],
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

// Auditor-only: get a specific dataset audit (includes emails)
export function useDatasetAudit(datasetId: number | undefined) {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();

  return useQuery({
    queryKey: ["dataset-audit", datasetId],
    queryFn: async () => {
      if (!datasetId) return null;

      const { data, error } = await supabase.rpc("get_dataset_audit_with_emails", {
        p_dataset_id: datasetId,
      });

      if (error) throw error;

      const rows = (Array.isArray(data) ? data : []) as DatasetAuditUserInfo[];
      return rows.length > 0 ? rows[0] : null;
    },
    enabled: !!datasetId && !!user?.id && canAudit,
  });
}

// Bulk hook to get audits for a set of dataset IDs
export function useDatasetAuditsByIds(datasetIds: number[]) {
  const idsKey = useMemo(
    () => (datasetIds && datasetIds.length > 0 ? [...new Set(datasetIds)].sort((a, b) => a - b) : []),
    [datasetIds],
  );

  const { user } = useAuth();
  const { canAudit } = useCanAudit();

  return useQuery({
    queryKey: ["dataset-audits-by-ids", idsKey],
    enabled: idsKey.length > 0 && !!user?.id && canAudit,
    queryFn: async () => {
      // We already need auditor privileges for emails; fetch once then filter locally.
      const { data, error } = await supabase.rpc("get_dataset_audits_with_emails");
      if (error) throw error;

      const rows = ((data || []) as DatasetAuditUserInfo[]).filter((row) => idsKey.includes(row.dataset_id));
      const map = new Map<number, DatasetAuditUserInfo>();
      rows.forEach((row) => map.set(row.dataset_id, row));
      return map;
    },
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
      return data && data.length > 0 ? data[0] : null;
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
    },
  });
}

// Update the existing useSaveDatasetAudit hook
export function useSaveDatasetAudit() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ values: auditData, leaseId }: { values: AuditFormValues; leaseId: string }) => {
      const dataToSave = {
        ...auditData,
        audited_by: user?.id,
        audit_date: new Date().toISOString(),
      };

      // Check if audit already exists
      const { data: existingAudits } = await supabase
        .from("dataset_audit")
        .select("dataset_id")
        .eq("dataset_id", auditData.dataset_id)
        .limit(1);

      const existingAudit = existingAudits && existingAudits.length > 0 ? existingAudits[0] : null;

      let auditResult;
      if (existingAudit) {
        // Update existing audit
        const { data, error } = await withAuditLease(
          supabase.from("dataset_audit").update(dataToSave).eq("dataset_id", auditData.dataset_id),
          leaseId,
        )
          .select()
          .single();

        if (error) throw error;
        auditResult = data;
      } else {
        // Insert new audit
        const { data, error } = await withAuditLease(supabase.from("dataset_audit").insert(dataToSave), leaseId)
          .select()
          .single();

        if (error) throw error;
        auditResult = data;
      }

      return auditResult;
    },
    onSuccess: (_, { values }) => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ["dataset-audits"] });
      queryClient.invalidateQueries({ queryKey: ["dataset-audit", values.dataset_id] });
      queryClient.invalidateQueries({ queryKey: ["dataset-aoi", values.dataset_id] });
      queryClient.invalidateQueries({ queryKey: ["datasets"] });
    },
  });
}

// New hook to fetch ortho metadata
export function useOrthoMetadata(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["ortho-metadata", datasetId],
    queryFn: async () => {
      if (!datasetId) return null;

      const { data, error } = await supabase
        .from("v2_orthos")
        .select("dataset_id, ortho_info")
        .eq("dataset_id", datasetId)
        .single();

      if (error) {
        if (error.code === "PGRST116") {
          // No data found
          return null;
        }
        throw error;
      }

      return data as OrthoMetadata;
    },
    enabled: !!datasetId,
  });
}

// Hook to mark a dataset audit as reviewed
export function useMarkAsReviewed() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ datasetId, leaseId }: { datasetId: number; leaseId: string }) => {
      const { data, error } = await withAuditLease(
        supabase
          .from("dataset_audit")
          .update({
            reviewed_at: new Date().toISOString(),
            reviewed_by: user?.id,
          })
          .eq("dataset_id", datasetId),
        leaseId,
      )
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, { datasetId }) => {
      queryClient.invalidateQueries({ queryKey: ["dataset-audits"] });
      queryClient.invalidateQueries({ queryKey: ["dataset-audit", datasetId] });
    },
  });
}
