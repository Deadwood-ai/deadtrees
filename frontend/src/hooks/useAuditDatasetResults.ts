import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import { AUDIT_RESULTS_KEY, audit } from "./useAuditChecks";
import type { IAuditDatasetResult } from "../types/auditChecks";

/** The columns of audit.dataset_outcomes the page reads (all of them, named so a renamed column fails loudly). */
const RESULT_COLUMNS = [
  "dataset_id",
  "current_status",
  "is_processing_done",
  "evaluation_decision",
  "evaluation_source",
  "cog_issue",
  "thumbnail_issue",
  "aoi_exists",
  "aoi_created_at",
  "aoi_source",
  "aoi_model_version",
  "aoi_empty",
  "georef_status",
  "georef_offset_m",
  "georef_source",
  "date_replace",
  "date_new",
  "date_predicted",
  "date_hdi80_days",
  "date_model_version",
  "date_estimated_at",
  "phenology_probability",
  "deadwood_total",
  "deadwood_major",
  "deadwood_minor",
  "deadwood_ok",
  "forest_cover_total",
  "forest_cover_major",
  "forest_cover_minor",
  "forest_cover_ok",
  "review_required",
  "in_benchmark",
].join(", ");

export const datasetResultKey = (datasetId: number | undefined) => [...AUDIT_RESULTS_KEY, datasetId];

/** One dataset's check outputs and what still needs a person (auditors only); null when the view has no row. */
export function useAuditDatasetResult(datasetId: number | undefined) {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: datasetResultKey(datasetId),
    queryFn: async () => {
      const { data, error } = await audit()
        .from("dataset_outcomes")
        .select(RESULT_COLUMNS)
        .eq("dataset_id", datasetId!)
        .maybeSingle()
        .overrideTypes<IAuditDatasetResult | null, { merge: false }>();
      if (error) throw error;
      return data ?? null;
    },
    enabled: !!datasetId && !!user?.id && canAudit,
  });
}
