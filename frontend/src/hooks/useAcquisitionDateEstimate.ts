import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import type { IAcquisitionDateDecision, IAcquisitionDateEstimate, IAuditReviewItem, IAuditSuggestion } from "../types/acquisitionDate";
import type { IGeorefCheck } from "../types/georefCheck";

/** The dataset's acquisition-date estimate (null until the stage has run). */
export function useAcquisitionDateEstimate(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["acquisition-date-estimate", datasetId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v2_acquisition_date_estimates")
        .select("*")
        .eq("dataset_id", datasetId!)
        .maybeSingle();
      if (error) throw error;
      return (data as IAcquisitionDateEstimate | null) ?? null;
    },
    enabled: !!datasetId,
    staleTime: 5 * 60 * 1000,
  });
}

/** Machine suggestions that prefill the audit form (auditors only). */
export function useAuditSuggestions(datasetId: number | undefined) {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: ["audit-suggestions", datasetId],
    queryFn: async () => {
      const { data, error } = await supabase.from("dataset_audit_suggestions").select("*").eq("dataset_id", datasetId!);
      if (error) throw error;
      return (data as IAuditSuggestion[]) ?? [];
    },
    // before the session is ready the request runs as anon and RLS returns []
    enabled: !!datasetId && !!user?.id && canAudit,
  });
}

/** The dataset's date decisions, newest first (the active one has no superseded_at). */
export function useAcquisitionDateDecisions(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["acquisition-date-decisions", datasetId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("acquisition_date_decisions")
        .select("*")
        .eq("dataset_id", datasetId!)
        .order("decided_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data as IAcquisitionDateDecision[]) ?? [];
    },
    enabled: !!datasetId,
    staleTime: 5 * 60 * 1000,
  });
}

/** Saved audit items that need a re-review because newer machine evidence
 * disagrees with them; all datasets, or one. Auditors only. */
export function useAuditReviewQueue(datasetId?: number) {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: ["audit-review-queue", datasetId ?? "all"],
    queryFn: async () => {
      let query = supabase.from("audit_review_queue").select("*");
      if (datasetId) query = query.eq("dataset_id", datasetId);
      const { data, error } = await query;
      if (error) throw error;
      return (data as IAuditReviewItem[]) ?? [];
    },
    enabled: !!user?.id && canAudit,
  });
}

/** The dataset's georeferencing check (null until the stage has run). */
export function useGeorefCheck(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["georef-check", datasetId],
    queryFn: async () => {
      const { data, error } = await supabase.from("v2_georef_checks").select("*").eq("dataset_id", datasetId!).maybeSingle();
      if (error) throw error;
      return (data as IGeorefCheck | null) ?? null;
    },
    enabled: !!datasetId,
    staleTime: 5 * 60 * 1000,
  });
}
