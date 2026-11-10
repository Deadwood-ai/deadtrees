import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import { fetchAuditImages } from "../api/auditImages";
import { freshUntilExpiry, refreshBeforeExpiry } from "../utils/signedFilesGrant";
import { mergeAnswers, runEvidence } from "../utils/auditChecks";
import type {
  IAuditAnswerInput,
  IAuditAssessment,
  IAuditChecks,
  IAuditCrop,
  IAuditImage,
  IAuditQueueRow,
  IAuditRun,
} from "../types/auditChecks";

export const audit = () => supabase.schema("audit");

/** PostgREST answers this while the audit schema is not in its exposed schemas. */
export const SCHEMA_NOT_EXPOSED = "PGRST106";

/** The columns the page reads of an assessment; the model's raw reply and likelihoods stay on the server. */
const ASSESSMENT_COLUMNS =
  "id, check_key, dataset_id, crop_id, run_id, layer, label_id, assessor_kind, assessor_user_id, model, prompt_version, assessor, verdict, reason_code, reason_text, details";
export const QUEUE_COLUMNS = "dataset_id, check_key, layer, run_id, verdict, reason";

export const auditChecksKey = (datasetId: number | undefined) => ["audit-checks", datasetId];

function unwrap<T>(result: { data: T[] | null; error: { code?: string; message: string } | null }): T[] {
  if (result.error) throw result.error;
  return result.data ?? [];
}

async function loadAuditChecks(datasetId: number): Promise<IAuditChecks> {
  const current = await audit().from("current_runs").select("run_id").eq("dataset_id", datasetId);
  if (current.error?.code === SCHEMA_NOT_EXPOSED) return { available: false, checks: {}, people: [] };
  const runIds = unwrap(current).map((c: { run_id: number }) => c.run_id);
  // most datasets have no check yet: one request tells
  if (!runIds.length) return { available: true, checks: {}, people: [] };
  const [runs, automated, queue, people, crops, images] = await Promise.all([
    audit().from("runs").select("id, check_key, inputs, evidence").in("id", runIds),
    audit().from("current_assessments").select(ASSESSMENT_COLUMNS).eq("dataset_id", datasetId),
    audit().from("review_queue").select(QUEUE_COLUMNS).eq("dataset_id", datasetId),
    audit()
      .from("latest_assessments")
      .select(ASSESSMENT_COLUMNS)
      .eq("dataset_id", datasetId)
      .eq("assessor_kind", "person")
      .is("imported_from", null),
    audit().from("crops").select("id, crop_sets, geometry, ortho_sha256").eq("dataset_id", datasetId),
    audit().from("images").select("id, crop_id, label_id, kind, storage_path, width, height, ortho_sha256").eq("dataset_id", datasetId),
  ]);
  const dataset = {
    automated: unwrap(automated) as IAuditAssessment[],
    queue: unwrap(queue) as IAuditQueueRow[],
    crops: unwrap(crops) as IAuditCrop[],
    images: unwrap(images) as IAuditImage[],
  };
  const checks: IAuditChecks["checks"] = {};
  for (const run of unwrap(runs) as IAuditRun[]) checks[run.check_key] = runEvidence(run, dataset);
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

/** Store the signed-in auditor's answers (one dataset, one or more targets) as new person rows;
 * earlier answers stay as history. The loaded checks take the new rows without a reload. */
export function useSaveAuditAnswers() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (answers: IAuditAnswerInput[]) => {
      if (!user?.id) throw new Error("Sign in to answer");
      const { data, error } = await audit()
        .from("assessments")
        .insert(answers.map((answer) => ({ ...answer, assessor_kind: "person", assessor_user_id: user.id })))
        .select(ASSESSMENT_COLUMNS);
      if (error) throw error;
      return (data as IAuditAssessment[]).map((row) => ({ ...row, assessor_email: user.email ?? null }));
    },
    onSuccess: async (rows, answers) => {
      const key = auditChecksKey(answers[0].dataset_id);
      // a reload that started before the insert would bring back the checks without the answer
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<IAuditChecks>(key, (checks) => checks && { ...checks, people: mergeAnswers(checks.people, rows) });
      queryClient.invalidateQueries({ queryKey: ["audit-check-queue"] });
    },
  });
}

/** Signed link prefix for the stored check images, renewed before it expires. The cached grant
 * outlives its readers: the ticket is part of every image link, so a new one would void the browser cache. */
export function useAuditImageAccess() {
  return useQuery({
    queryKey: ["audit-image-access"],
    queryFn: fetchAuditImages,
    staleTime: freshUntilExpiry,
    gcTime: 60 * 60 * 1000,
    refetchInterval: refreshBeforeExpiry,
  });
}
