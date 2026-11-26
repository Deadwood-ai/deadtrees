import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import type { IDatasetAuditSummary } from "../types/auditChecks";

/** What the audit found on a dataset, for the dataset page's audit panel: anyone who can see the
 * dataset reads it (public.get_dataset_audit_summary); null when it has no audit results. */
export function useDatasetAuditSummary(datasetId: number | undefined) {
  return useQuery({
    queryKey: ["dataset-audit-summary", datasetId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_dataset_audit_summary", { p_dataset_id: datasetId });
      if (error) throw error;
      return (data ?? null) as IDatasetAuditSummary | null;
    },
    enabled: !!datasetId,
  });
}
