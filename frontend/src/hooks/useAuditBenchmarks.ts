import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import { ASSESSMENT_COLUMNS, audit, useSaveAuditAnswers, withEmails } from "./useAuditChecks";
import type {
  AuditCheckKey,
  IAuditAnswerInput,
  IAuditAssessment,
  IAuditBenchmark,
  IAuditImage,
  IBenchmarkData,
  IBenchmarkTarget,
} from "../types/auditChecks";
import { mergeAnswers } from "../utils/auditChecks";

/** The checks with a benchmark people label, in the order the tab lists them. */
export const BENCHMARK_CHECKS: { checkKey: AuditCheckKey; title: string }[] = [
  { checkKey: "prediction_quality", title: "Prediction quality" },
  { checkKey: "dataset_evaluation", title: "Dataset evaluation" },
];

const IMAGE_COLUMNS = "id, crop_id, label_id, kind, storage_path, width, height, ortho_sha256, dataset_id";
// a list filter travels in the URL; 100 ids stay well under its limit
const CHUNK = 100;

function unwrap<T>(result: { data: T[] | null; error: { message: string } | null }): T[] {
  if (result.error) throw result.error;
  return result.data ?? [];
}

const chunks = <T,>(items: T[]) => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, i) => items.slice(i * CHUNK, (i + 1) * CHUNK));

/** Rows for many ids, a chunk per request. */
async function byIds<T>(ids: number[], load: (chunk: number[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const parts = await Promise.all(chunks(ids).map((chunk) => load(chunk)));
  return parts.flatMap(unwrap);
}

/** The newest row per assessor and layer (assessments are append-only; ids grow). */
const latestPerAssessor = (rows: IAuditAssessment[]) => {
  const latest = new Map<string, IAuditAssessment>();
  for (const row of [...rows].sort((a, b) => a.id - b.id)) latest.set(`${row.dataset_id}:${row.crop_id}:${row.layer}:${row.assessor}`, row);
  return [...latest.values()];
};

type TargetRef = { dataset_id: number; crop_id: number | null };
/** A row about the target: its crop, or for a dataset target the dataset itself. */
const isOnTarget = (target: TargetRef, row: TargetRef) =>
  target.crop_id === null ? row.dataset_id === target.dataset_id && row.crop_id === null : row.crop_id === target.crop_id;

/** The images a labeler sees: per crop the newest raw image and overlay of each kind; per dataset
 * the newest overview and thumbnail and the evaluation crops of that ortho. */
function targetImages(target: { dataset_id: number; crop_id: number | null }, images: IAuditImage[], evaluationCrops: Set<number>): IAuditImage[] {
  const newest = new Map<string, IAuditImage>();
  const own = images.filter((i) => (target.crop_id === null ? i.dataset_id === target.dataset_id : i.crop_id === target.crop_id));
  for (const image of [...own].sort((a, b) => a.id - b.id)) {
    const key = target.crop_id === null && image.crop_id !== null ? `crop:${image.crop_id}` : image.kind;
    newest.set(key, image);
  }
  const chosen = [...newest.values()];
  if (target.crop_id !== null) return chosen;
  const ortho = chosen.find((i) => i.kind === "overview")?.ortho_sha256;
  return chosen.filter((i) => i.crop_id === null || (evaluationCrops.has(i.crop_id) && (!ortho || i.ortho_sha256 === ortho)));
}

async function loadBenchmark(benchmark: IAuditBenchmark): Promise<IBenchmarkData> {
  const members = unwrap(
    await audit().from("benchmark_members").select("id, dataset_id, crop_id, split").eq("benchmark_id", benchmark.id).order("id"),
  ) as Pick<IBenchmarkTarget, "id" | "dataset_id" | "crop_id" | "split">[];
  const cropIds = members.map((m) => m.crop_id).filter((id): id is number => id !== null);
  const datasetIds = [...new Set(members.filter((m) => m.crop_id === null).map((m) => m.dataset_id))];
  const onCrops = cropIds.length > 0;
  const ids = onCrops ? cropIds : datasetIds;
  const column = onCrops ? "crop_id" : "dataset_id";
  const [images, people, models, evaluationCrops] = await Promise.all([
    byIds<IAuditImage>(ids, (chunk) =>
      onCrops
        ? audit().from("images").select(IMAGE_COLUMNS).in("crop_id", chunk)
        : audit().from("images").select(IMAGE_COLUMNS).in("dataset_id", chunk).in("kind", ["overview", "thumbnail", "raw"]),
    ),
    byIds<IAuditAssessment>(ids, (chunk) => {
      const query = audit()
        .from("latest_assessments")
        .select(ASSESSMENT_COLUMNS)
        .eq("check_key", benchmark.check_key)
        .eq("assessor_kind", "person")
        .is("imported_from", null)
        .in(column, chunk);
      return onCrops ? query : query.is("crop_id", null);
    }),
    byIds<IAuditAssessment>(ids, (chunk) => {
      const query = audit()
        .from("assessments")
        .select(ASSESSMENT_COLUMNS)
        .eq("check_key", benchmark.check_key)
        .in("assessor_kind", ["model", "rule"])
        .in(column, chunk);
      return onCrops ? query : query.is("crop_id", null);
    }),
    onCrops
      ? Promise.resolve([] as { id: number }[])
      : byIds<{ id: number }>(datasetIds, (chunk) => audit().from("crops").select("id").in("dataset_id", chunk).contains("crop_sets", ["evaluation"])),
  ]);
  const named = await withEmails(people);
  const latestModels = latestPerAssessor(models);
  const evaluation = new Set(evaluationCrops.map((c) => c.id));
  return {
    benchmark,
    targets: members.map((m) => ({
      ...m,
      images: targetImages(m, images, evaluation),
      people: named.filter((r) => isOnTarget(m, r)),
      models: latestModels.filter((r) => isOnTarget(m, r)),
    })),
  };
}

const benchmarksKey = ["audit-benchmarks"];
export const benchmarkKey = (id: number | undefined) => ["audit-benchmark", id];

/** The open benchmark version of each check (one at most per check), auditors only. */
export function useOpenBenchmarks() {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: benchmarksKey,
    queryFn: async () =>
      unwrap(await audit().from("benchmarks").select("id, check_key, name, version").is("frozen_at", null)) as IAuditBenchmark[],
    enabled: !!user?.id && canAudit,
  });
}

/** One benchmark's targets with their images, people's answers and the models' answers. */
export function useBenchmark(benchmark: IAuditBenchmark | undefined) {
  return useQuery({
    queryKey: benchmarkKey(benchmark?.id),
    queryFn: () => loadBenchmark(benchmark!),
    enabled: !!benchmark,
    staleTime: 60_000,
  });
}

/** Stores a label on a benchmark target (new person rows, no run) and adds them to the loaded benchmark. */
export function useSaveBenchmarkLabel(benchmarkId: number | undefined) {
  const queryClient = useQueryClient();
  const { mutateAsync, isPending } = useSaveAuditAnswers();
  const save = async (answers: IAuditAnswerInput[]) => {
    const rows = await mutateAsync(answers);
    queryClient.setQueryData<IBenchmarkData>(benchmarkKey(benchmarkId), (data) =>
      data && {
        ...data,
        targets: data.targets.map((t) => {
          const added = rows.filter((r) => isOnTarget(t, r));
          return added.length ? { ...t, people: mergeAnswers(t.people, added) } : t;
        }),
      },
    );
    return rows;
  };
  return { save, isPending };
}

/** Whether a dataset or crop is already a target of its check's open benchmark. */
export function useBenchmarkMembership(datasetId: number | undefined) {
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: ["audit-benchmark-membership", datasetId],
    queryFn: async () =>
      unwrap(
        await audit()
          .from("benchmark_members")
          .select("crop_id, benchmark:benchmarks!inner(check_key, frozen_at)")
          .eq("dataset_id", datasetId!)
          .is("benchmark.frozen_at", null),
      ) as unknown as { crop_id: number | null; benchmark: { check_key: AuditCheckKey } }[],
    enabled: !!datasetId && canAudit,
  });
}

/** Adds a crop, or the whole dataset (cropId null), to the open benchmark of a check
 * (audit.add_benchmark_target, operators only). Adding a target that is already in it is a no-op. */
export function useAddBenchmarkTarget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ checkKey, datasetId, cropId = null }: { checkKey: AuditCheckKey; datasetId: number; cropId?: number | null }) => {
      const { data, error } = await audit().rpc("add_benchmark_target", { p_check_key: checkKey, p_dataset_id: datasetId, p_crop_id: cropId });
      if (error) throw error;
      return data as { id: number; split: string };
    },
    onSuccess: (_, { datasetId }) => {
      queryClient.invalidateQueries({ queryKey: ["audit-benchmark-membership", datasetId] });
      queryClient.invalidateQueries({ queryKey: ["audit-benchmark"] });
    },
  });
}
