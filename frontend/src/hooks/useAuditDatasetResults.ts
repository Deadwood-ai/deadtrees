import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import { AUDIT_RESULTS_KEY, SCHEMA_NOT_EXPOSED, allRows, audit, withEmails } from "./useAuditChecks";
import type { IAuditAssessment, IAuditDatasetResult } from "../types/auditChecks";

/** The columns of audit.dataset_results the page reads (all of them, named so a renamed column fails loudly). */
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
  "georef_status",
  "georef_offset_m",
  "georef_source",
  "date_replace",
  "date_new",
  "date_predicted",
  "date_hdi80_days",
  "date_model_version",
  "date_estimated_at",
  "date_source",
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
  "last_reviewed_at",
  "in_benchmark",
  "checks_run",
].join(", ");

export const datasetResultKey = (datasetId: number | undefined) => [...AUDIT_RESULTS_KEY, datasetId];

const RESULTS_STALE_MS = 60 * 1000;

/** One dataset's check outputs and what still needs a person (auditors only); null when the view has no row. */
export function useAuditDatasetResult(datasetId: number | undefined) {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: datasetResultKey(datasetId),
    queryFn: async () => {
      const { data, error } = await audit()
        .from("dataset_results")
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

export interface IAuditResultsList {
  /** false while the audit schema cannot be read on this server */
  available: boolean;
  rows: IAuditDatasetResult[];
}

/** Every dataset's row of audit.dataset_results, read page by page (auditors only). */
export function useAuditDatasetResults() {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: [...AUDIT_RESULTS_KEY, "all"],
    queryFn: async (): Promise<IAuditResultsList> => {
      try {
        const rows = await allRows<IAuditDatasetResult>((from, to) =>
          audit()
            .from("dataset_results")
            .select(RESULT_COLUMNS)
            .order("dataset_id", { ascending: false })
            .range(from, to)
            .overrideTypes<IAuditDatasetResult[], { merge: false }>(),
        );
        return { available: true, rows };
      } catch (error) {
        if ((error as { code?: string }).code === SCHEMA_NOT_EXPOSED) return { available: false, rows: [] };
        throw error;
      }
    },
    enabled: !!user?.id && canAudit,
    staleTime: RESULTS_STALE_MS,
  });
}

/** Who gave native answers on each dataset (dataset level), with their emails: the list's
 * "reviewed by" filter. Imported legacy audits are not reviews of this page. */
export function useAuditReviewers() {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: [...AUDIT_RESULTS_KEY, "reviewers"],
    queryFn: async () => {
      const rows = await allRows<Pick<IAuditAssessment, "id" | "dataset_id" | "assessor_user_id" | "assessor">>((from, to) =>
        audit()
          .from("latest_assessments")
          .select("id, dataset_id, assessor_user_id, assessor")
          .eq("assessor_kind", "person")
          .is("crop_id", null)
          .is("imported_from", null)
          .order("id")
          .range(from, to),
      );
      const named = await withEmails(rows as IAuditAssessment[]);
      const byDataset = new Map<number, Set<string>>();
      for (const row of named) {
        const who = row.assessor_email ?? row.assessor_user_id;
        if (who) byDataset.set(row.dataset_id, (byDataset.get(row.dataset_id) ?? new Set()).add(who));
      }
      return byDataset;
    },
    enabled: !!user?.id && canAudit,
    staleTime: RESULTS_STALE_MS,
  });
}

