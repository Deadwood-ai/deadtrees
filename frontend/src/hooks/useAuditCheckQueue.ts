import { useQuery } from "@tanstack/react-query";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import { QUEUE_COLUMNS, SCHEMA_NOT_EXPOSED, audit } from "./useAuditChecks";
import type { AuditCheckKey, AuditLayer, AuditVerdict, IAuditQueueRow } from "../types/auditChecks";
import { reviewKey } from "../utils/auditReviewList";

/** One row of audit.disagreements: a target where people, or people and the models, disagree. */
export interface IAuditDisagreement {
  check_key: AuditCheckKey;
  dataset_id: number;
  crop_id: number | null;
  layer: AuditLayer;
  verdicts: Record<string, AuditVerdict>;
  people_disagree: boolean;
  people_and_models_disagree: boolean;
  legacy_and_models_disagree: boolean;
}

/** A list from the audit schema. `total` can exceed `rows.length`: the server caps a response. */
interface IAuditList<T> {
  /** false while the audit schema cannot be read */
  available: boolean;
  rows: T[];
  total: number;
}

export interface IAuditReviewList extends IAuditList<IAuditQueueRow> {
  /** people who answered on the current run, and whether you did, per "dataset:check:layer" */
  reviews: Record<string, { count: number; mine: boolean }>;
}


const NOT_AVAILABLE = { available: false, rows: [], total: 0 };
const ANSWER_PAGE = 1000;

async function loadToReview(userId: string): Promise<IAuditReviewList> {
  // every result under review, answered or not: each reviewer answers on their own
  const queue = await audit()
    .from("review_queue")
    .select(QUEUE_COLUMNS, { count: "exact" })
    .not("reason", "is", null)
    .order("dataset_id", { ascending: false });
  if (queue.error?.code === SCHEMA_NOT_EXPOSED) return { ...NOT_AVAILABLE, reviews: {} };
  if (queue.error) throw queue.error;
  const rows = (queue.data ?? []) as IAuditQueueRow[];
  const reviews: IAuditReviewList["reviews"] = {};
  if (rows.length) {
    const runs = new Map(rows.map((r) => [reviewKey(r), r.run_id]));
    // The rows come sorted by dataset, so their answers lie between the last and the first id.
    // Read them page by page: one response holds at most the server's row cap.
    for (let from = 0; ; from += ANSWER_PAGE) {
      const people = await audit()
        .from("latest_assessments")
        .select("id, dataset_id, check_key, layer, run_id, assessor_user_id")
        .gte("dataset_id", rows[rows.length - 1].dataset_id)
        .lte("dataset_id", rows[0].dataset_id)
        .eq("assessor_kind", "person")
        .is("crop_id", null)
        .is("imported_from", null)
        .order("id")
        .range(from, from + ANSWER_PAGE - 1);
      if (people.error) throw people.error;
      for (const row of people.data ?? []) {
        const key = reviewKey(row);
        if (runs.get(key) !== row.run_id) continue;
        const entry = (reviews[key] ??= { count: 0, mine: false });
        entry.count += 1;
        entry.mine ||= row.assessor_user_id === userId;
      }
      if ((people.data ?? []).length < ANSWER_PAGE) break;
    }
  }
  return { available: true, rows, total: queue.count ?? rows.length, reviews };
}

async function loadDisagreements(): Promise<IAuditList<IAuditDisagreement>> {
  const result = await audit()
    .from("disagreements")
    .select("check_key, dataset_id, crop_id, layer, verdicts, people_disagree, people_and_models_disagree, legacy_and_models_disagree", {
      count: "exact",
    })
    .order("last_assessed_at", { ascending: false });
  if (result.error?.code === SCHEMA_NOT_EXPOSED) return NOT_AVAILABLE;
  if (result.error) throw result.error;
  const rows = (result.data ?? []) as IAuditDisagreement[];
  return { available: true, rows, total: result.count ?? rows.length };
}

const QUEUE_STALE_MS = 60 * 1000;

/** Check results under review, with who answered them (auditors only). */
export function useAuditReviewList() {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: ["audit-check-queue", "to-review", user?.id],
    queryFn: () => loadToReview(user!.id),
    enabled: !!user?.id && canAudit,
    staleTime: QUEUE_STALE_MS,
  });
}

/** Targets where reviewers disagree with each other or with the models, for adjudication (auditors only). */
export function useAuditDisagreements() {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: ["audit-check-queue", "disagreements", user?.id],
    queryFn: loadDisagreements,
    enabled: !!user?.id && canAudit,
    staleTime: QUEUE_STALE_MS,
  });
}
