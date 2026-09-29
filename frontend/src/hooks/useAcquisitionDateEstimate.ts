import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import type { IAcquisitionDateEstimate, IAuditSuggestion } from "../types/acquisitionDate";

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
