import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import { fetchAuditImages } from "../api/auditImages";
import type {
  AuditCheckKey,
  IAuditAnswerInput,
  IAuditAssessment,
  IAuditCheckEvidence,
  IAuditChecks,
  IAuditCrop,
  IAuditImage,
  IAuditQueueRow,
  IAuditRun,
} from "../types/auditChecks";

const audit = () => supabase.schema("audit");

/** PostgREST answers this while the audit schema is not in its exposed schemas. */
const SCHEMA_NOT_EXPOSED = "PGRST106";

/** The crop sets each check picks (audit.crops.crop_sets). */
const CHECK_CROP_SETS: Partial<Record<AuditCheckKey, string[]>> = {
  dataset_evaluation: ["evaluation"],
  prediction_quality: ["exclude", "training"],
};

export const auditChecksKey = (datasetId: number | undefined) => ["audit-checks", datasetId];

function unwrap<T>(result: { data: T[] | null; error: { code?: string; message: string } | null }): T[] {
  if (result.error) throw result.error;
  return result.data ?? [];
}

async function loadAuditChecks(datasetId: number): Promise<IAuditChecks> {
  const current = await audit().from("current_runs").select("check_key, run_id").eq("dataset_id", datasetId);
  if (current.error?.code === SCHEMA_NOT_EXPOSED) return { available: false, checks: {}, people: [] };
  const runIds = unwrap(current).map((c: { run_id: number }) => c.run_id);
  const [runs, automated, queue, people, crops, images] = await Promise.all([
    audit().from("runs").select("id, check_key, status, inputs, evidence, coverage, finished_at").in("id", runIds),
    audit().from("current_assessments").select("*").eq("dataset_id", datasetId),
    audit().from("review_queue").select("*").eq("dataset_id", datasetId),
    audit()
      .from("latest_assessments")
      .select("*")
      .eq("dataset_id", datasetId)
      .eq("assessor_kind", "person")
      .is("imported_from", null),
    audit().from("crops").select("id, crop_sets, geometry, mpp, size_px, selection, ortho_sha256").eq("dataset_id", datasetId),
    audit()
      .from("images")
      .select("id, crop_id, label_id, kind, storage_path, width, height, ortho_sha256")
      .eq("dataset_id", datasetId),
  ]);
  const automatedRows = unwrap(automated) as IAuditAssessment[];
  const cropRows = unwrap(crops) as (IAuditCrop & { ortho_sha256: string })[];
  const imageRows = unwrap(images) as (IAuditImage & { ortho_sha256: string })[];
  const queueRows = unwrap(queue) as IAuditQueueRow[];
  const checks: IAuditChecks["checks"] = {};
  for (const run of unwrap(runs) as IAuditRun[]) {
    const rows = automatedRows.filter((a) => a.check_key === run.check_key);
    const ortho = run.inputs.ortho_sha256;
    // the crops the run judged: those its rows name, and its own set's crops of the same ortho
    // (the dataset evaluation judges its crops in one dataset-level answer)
    const judged = new Set(rows.map((a) => a.crop_id).filter((id): id is number => id !== null));
    const runCrops = cropRows.filter(
      (c) => judged.has(c.id) || (c.ortho_sha256 === ortho && c.crop_sets.some((set) => CHECK_CROP_SETS[run.check_key]?.includes(set))),
    );
    const cropIds = new Set(runCrops.map((c) => c.id));
    checks[run.check_key] = {
      run,
      automated: rows,
      queue: queueRows.filter((q) => q.check_key === run.check_key),
      crops: runCrops,
      images: imageRows.filter((i) => (i.crop_id === null ? i.ortho_sha256 === ortho : cropIds.has(i.crop_id))),
    } satisfies IAuditCheckEvidence;
  }
  return { available: true, checks, people: await withEmails(unwrap(people) as IAuditAssessment[]) };
}

/** Reviewers' emails for their answers (get_user_emails answers auditors only); ids stay when it fails. */
async function withEmails(rows: IAuditAssessment[]): Promise<IAuditAssessment[]> {
  const ids = [...new Set(rows.map((r) => r.assessor_user_id).filter((id): id is string => !!id))];
  if (!ids.length) return rows;
  const { data, error } = await supabase.rpc("get_user_emails", { p_user_ids: ids });
  if (error || !data) return rows;
  const emails = new Map((data as { user_id: string; email: string | null }[]).map((r) => [r.user_id, r.email]));
  return rows.map((r) => ({ ...r, assessor_email: emails.get(r.assessor_user_id ?? "") ?? null }));
}

/** The dataset's automated audit checks, their evidence and people's answers (auditors only). */
export function useAuditChecks(datasetId: number | undefined) {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: auditChecksKey(datasetId),
    queryFn: () => loadAuditChecks(datasetId!),
    enabled: !!datasetId && !!user?.id && canAudit,
  });
}

/** Store the signed-in auditor's answer as a new person row; earlier answers stay as history. */
export function useSaveAuditAnswer() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (answer: IAuditAnswerInput) => {
      if (!user?.id) throw new Error("Sign in to answer");
      const { error } = await audit()
        .from("assessments")
        .insert({ ...answer, assessor_kind: "person", assessor_user_id: user.id });
      if (error) throw error;
    },
    onSuccess: (_, answer) => {
      queryClient.invalidateQueries({ queryKey: auditChecksKey(answer.dataset_id) });
      queryClient.invalidateQueries({ queryKey: ["audit-check-queue"] });
    },
  });
}

/** Signed link prefix for the stored check images, renewed before it expires. */
export function useAuditImageAccess(enabled: boolean) {
  return useQuery({
    queryKey: ["audit-image-access"],
    queryFn: fetchAuditImages,
    enabled,
    staleTime: 45 * 60 * 1000,
    refetchInterval: 45 * 60 * 1000,
  });
}
