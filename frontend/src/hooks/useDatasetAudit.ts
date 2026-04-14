import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import { useMemo } from "react";
import { IDataset } from "../types/dataset";

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
  image_quality?: number;
  notes?: string;
  created_at?: string;
  updated_at?: string;
}

// New interface for ortho metadata
export interface OrthoMetadata {
  dataset_id: number;
  ortho_info: Record<string, any>;
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
    mutationFn: async (aoiData: AOIData) => {
      const dataToSave = {
        ...aoiData,
        user_id: user?.id,
        updated_at: new Date().toISOString(),
      };

      // Check if AOI already exists for this dataset
      const { data: existingAOI } = await supabase
        .from("v2_aois")
        .select("id")
        .eq("dataset_id", aoiData.dataset_id)
        .limit(1);

      let result;
      if (existingAOI && existingAOI.length > 0) {
        // Update existing AOI
        const { data, error } = await supabase
          .from("v2_aois")
          .update(dataToSave)
          .eq("dataset_id", aoiData.dataset_id)
          .select()
          .single();

        if (error) throw error;
        result = data;
      } else {
        // Insert new AOI record
        const { data, error } = await supabase.from("v2_aois").insert(dataToSave).select().single();

        if (error) throw error;
        result = data;
      }

      return result;
    },
    onSuccess: (_, variables) => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ["dataset-aoi", variables.dataset_id] });
    },
  });
}

// Hook to set audit lock with auto-recovery for stale locks
export function useSetAuditLock() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (datasetId: number) => {
      // First check if already in audit
      const { data: statusCheck, error: checkError } = await supabase
        .from("v2_statuses")
        .select("is_in_audit, updated_at")
        .eq("dataset_id", datasetId)
        .single();

      if (checkError) throw checkError;

      if (statusCheck.is_in_audit) {
        // Check if the lock is stale (older than 1 hour)
        const lockTime = new Date(statusCheck.updated_at).getTime();
        const currentTime = new Date().getTime();
        const hoursSinceUpdate = (currentTime - lockTime) / (1000 * 60 * 60);

        if (hoursSinceUpdate >= 1) {
          // Auto-clear stale lock
          console.debug(
            `Auto-clearing stale audit lock for dataset ${datasetId} (${hoursSinceUpdate.toFixed(1)} hours old)`,
          );

          const { error: clearError } = await supabase
            .from("v2_statuses")
            .update({
              is_in_audit: false,
              updated_at: new Date().toISOString(),
            })
            .eq("dataset_id", datasetId);

          if (clearError) {
            console.error("Failed to clear stale lock:", clearError);
            throw new Error("Failed to clear stale audit lock");
          }
        } else {
          // Lock is recent, still active
          const timeRemaining = 60 - Math.floor(hoursSinceUpdate * 60);
          throw new Error(
            `Dataset is currently being audited by another user. Lock expires in ~${timeRemaining} minutes.`,
          );
        }
      }

      // Set new audit lock
      const { error } = await supabase
        .from("v2_statuses")
        .update({
          is_in_audit: true,
          updated_at: new Date().toISOString(),
        })
        .eq("dataset_id", datasetId);

      if (error) throw error;
      return datasetId;
    },
    onSuccess: (datasetId) => {
      queryClient.invalidateQueries({ queryKey: ["audit-status", datasetId] });
    },
  });
}

// Hook to clear audit lock
export function useClearAuditLock() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (datasetId: number) => {
      const { error } = await supabase
        .from("v2_statuses")
        .update({
          is_in_audit: false,
          updated_at: new Date().toISOString(),
        })
        .eq("dataset_id", datasetId);

      if (error) throw error;
      return datasetId;
    },
    onSuccess: (datasetId) => {
      queryClient.invalidateQueries({ queryKey: ["audit-status", datasetId] });
    },
  });
}

// Update the existing useSaveDatasetAudit hook
export function useSaveDatasetAudit() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (auditData: AuditFormValues & { aoiGeometry?: GeoJSON.MultiPolygon | GeoJSON.Polygon }) => {
      const { aoiGeometry, ...auditFormData } = auditData;

      const dataToSave = {
        ...auditFormData,
        audited_by: user?.id,
        audit_date: new Date().toISOString(),
      };

      // If AOI geometry is provided, save it first
      if (aoiGeometry) {
        const aoiData: AOIData = {
          dataset_id: auditData.dataset_id!,
          user_id: user?.id,
          geometry: aoiGeometry,
          is_whole_image: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        const { error: aoiError } = await supabase.from("v2_aois").insert(aoiData);
        if (aoiError) {
          console.error("Failed to save AOI:", aoiError);
          throw new Error("Failed to save AOI data");
        }

        dataToSave.aoi_done = true;
      }

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
        const { data, error } = await supabase
          .from("dataset_audit")
          .update(dataToSave)
          .eq("dataset_id", auditData.dataset_id)
          .select()
          .single();

        if (error) throw error;
        auditResult = data;
      } else {
        // Insert new audit
        const { data, error } = await supabase.from("dataset_audit").insert(dataToSave).select().single();

        if (error) throw error;
        auditResult = data;
      }

      // Clear the audit lock (is_audited is now computed from dataset_audit table)
      const { error: statusError } = await supabase
        .from("v2_statuses")
        .update({
          is_in_audit: false,
          updated_at: new Date().toISOString(),
        })
        .eq("dataset_id", auditData.dataset_id);

      if (statusError) {
        console.error("Failed to update status:", statusError);
        throw new Error("Failed to update audit status");
      }

      return auditResult;
    },
    onSuccess: (_, variables) => {
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: ["dataset-audits"] });
      queryClient.invalidateQueries({ queryKey: ["dataset-audit", variables.dataset_id] });
      queryClient.invalidateQueries({ queryKey: ["dataset-aoi", variables.dataset_id] });
      queryClient.invalidateQueries({ queryKey: ["audit-status", variables.dataset_id] });
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
    mutationFn: async (datasetId: number) => {
      const { data, error } = await supabase
        .from("dataset_audit")
        .update({
          reviewed_at: new Date().toISOString(),
          reviewed_by: user?.id,
        })
        .eq("dataset_id", datasetId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: (_, datasetId) => {
      queryClient.invalidateQueries({ queryKey: ["dataset-audits"] });
      queryClient.invalidateQueries({ queryKey: ["dataset-audit", datasetId] });
    },
  });
}
