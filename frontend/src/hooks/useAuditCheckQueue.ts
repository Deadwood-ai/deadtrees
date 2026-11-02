import { useQuery } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import type { AuditCheckKey, AuditLayer, AuditVerdict, IAuditQueueRow } from "../types/auditChecks";

export type AuditCheckQueueKind = "to-review" | "disagreements";

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
  last_assessed_at: string;
}

export interface IAuditCheckQueue {
  /** false while the audit schema cannot be read */
  available: boolean;
  toReview: IAuditQueueRow[];
  disagreements: IAuditDisagreement[];
  /** people who answered on the current run, and whether you did, per "dataset:check:layer" */
  reviews: Record<string, { count: number; mine: boolean }>;
}

export const reviewKey = (r: { dataset_id: number; check_key: string; layer: string }) => `${r.dataset_id}:${r.check_key}:${r.layer}`;

async function loadQueue(userId: string): Promise<IAuditCheckQueue> {
  const audit = supabase.schema("audit");
  const [queue, disagreements] = await Promise.all([
    // every result under review, answered or not: each reviewer answers on their own
    audit.from("review_queue").select("*").not("reason", "is", null).order("dataset_id", { ascending: false }),
    audit.from("disagreements").select("*").order("last_assessed_at", { ascending: false }),
  ]);
  if (queue.error?.code === "PGRST106") return { available: false, toReview: [], disagreements: [], reviews: {} };
  if (queue.error) throw queue.error;
  if (disagreements.error) throw disagreements.error;
  const toReview = (queue.data ?? []) as IAuditQueueRow[];
  const ids = [...new Set(toReview.map((r) => r.dataset_id))];
  const reviews: IAuditCheckQueue["reviews"] = {};
  if (ids.length) {
    const people = await audit
      .from("latest_assessments")
      .select("dataset_id, check_key, layer, run_id, assessor_user_id")
      .in("dataset_id", ids)
      .eq("assessor_kind", "person")
      .is("crop_id", null)
      .is("imported_from", null);
    if (people.error) throw people.error;
    const runs = new Map(toReview.map((r) => [reviewKey(r), r.run_id]));
    for (const row of people.data ?? []) {
      const key = reviewKey(row);
      if (runs.get(key) !== row.run_id) continue;
      const entry = (reviews[key] ??= { count: 0, mine: false });
      entry.count += 1;
      entry.mine ||= row.assessor_user_id === userId;
    }
  }
  return { available: true, toReview, disagreements: (disagreements.data ?? []) as IAuditDisagreement[], reviews };
}

/** Check results under review, and disagreements for adjudication (auditors only). */
export function useAuditCheckQueue(enabled: boolean) {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: ["audit-check-queue", user?.id],
    queryFn: () => loadQueue(user!.id),
    enabled: enabled && !!user?.id && canAudit,
  });
}
