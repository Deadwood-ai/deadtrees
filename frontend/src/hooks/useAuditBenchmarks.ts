import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import { ASSESSMENT_COLUMNS, audit, useSaveAuditAnswers, withEmails } from "./useAuditChecks";
import type {
  AuditCheckKey,
  IAuditAnswerInput,
  IAuditAssessment,
  IAuditBenchmark,
  IAuditCrop,
  IAuditImage,
  IAuditRun,
  IBenchmarkData,
  IBenchmarkTarget,
} from "../types/auditChecks";
import { mergeAnswers, runEvidence } from "../utils/auditChecks";

/** The checks with a benchmark people label, in the order the tab lists them. */
export const BENCHMARK_CHECKS: { checkKey: AuditCheckKey; title: string }[] = [
  { checkKey: "prediction_quality", title: "Prediction quality" },
  { checkKey: "dataset_evaluation", title: "Dataset evaluation" },
];

const CROP_COLUMNS = "id, dataset_id, crop_sets, ortho_sha256, geometry";
type CropRow = IAuditCrop & { dataset_id: number };
const IMAGE_COLUMNS = "id, crop_id, label_id, kind, storage_path, width, height, ortho_sha256, dataset_id";
// a list filter travels in the URL; 100 ids stay well under its limit
const CHUNK = 100;
// the server answers at most this many rows per request (max_rows, supabase/config.toml)
const PAGE = 1000;

type Rows<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

function unwrap<T>(result: { data: T[] | null; error: { message: string } | null }): T[] {
  if (result.error) throw result.error;
  return result.data ?? [];
}

/** Every row of a query, page after page; `page` orders the query and asks for rows from..to. */
async function allRows<T>(page: (from: number, to: number) => Rows<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const part = unwrap(await page(from, from + PAGE - 1));
    rows.push(...part);
    if (part.length < PAGE) return rows;
  }
}

/** Every row for many ids: a chunk of ids per query, each read to the end. */
async function byIds<T>(ids: number[], page: (chunk: number[], from: number, to: number) => Rows<T>): Promise<T[]> {
  const chunks = Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) => ids.slice(i * CHUNK, (i + 1) * CHUNK));
  const parts = await Promise.all(chunks.map((chunk) => allRows<T>((from, to) => page(chunk, from, to))));
  return parts.flat();
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

/** The images a labeler sees: per crop the newest image of each kind; per dataset the newest
 * overview and thumbnail and the newest raw image of each evaluation crop, of the overview's ortho. */
function targetImages(target: TargetRef, images: IAuditImage[]): IAuditImage[] {
  const newest = new Map<string, IAuditImage>();
  const own = images.filter((i) => (target.crop_id === null ? i.dataset_id === target.dataset_id : i.crop_id === target.crop_id));
  for (const image of [...own].sort((a, b) => a.id - b.id)) newest.set(image.crop_id !== null && target.crop_id === null ? `crop:${image.crop_id}` : image.kind, image);
  const chosen = [...newest.values()];
  const ortho = chosen.find((i) => i.kind === "overview")?.ortho_sha256;
  return target.crop_id !== null || !ortho ? chosen : chosen.filter((i) => i.ortho_sha256 === ortho);
}

/** The run a label on the target carries, so it stays the labeler's review answer too: the check's
 * current run on the dataset when that run judged the target (for a crop: has model rows on it).
 * audit.latest_assessments keeps one row per person and target across runs, so a label without
 * that run would hide the person's review of the current run. Gold crops no run judged get none. */
function labelRun(target: TargetRef, current: Map<number, number>, models: IAuditAssessment[]): number | null {
  const run = current.get(target.dataset_id) ?? null;
  if (run === null || target.crop_id === null) return run;
  return models.some((m) => m.crop_id === target.crop_id && m.run_id === run) ? run : null;
}

/** The images of a target as the run that judged it saw them, picked by the review page's own
 * rule (runEvidence): the run's crops, and its own file where it differs from the stored row (a
 * rerun keeps the first overview row, so the stored one may show an older AOI). */
function runImages(target: TargetRef, run: IAuditRun, loaded: { models: IAuditAssessment[]; crops: (CropRow)[]; images: IAuditImage[] }) {
  const evidence = runEvidence(run, {
    automated: loaded.models.filter((m) => m.run_id === run.id),
    queue: [],
    crops: loaded.crops.filter((c) => c.dataset_id === target.dataset_id),
    images: loaded.images.filter((i) => i.dataset_id === target.dataset_id),
  });
  return target.crop_id === null ? evidence.images.filter((i) => i.crop_id === null || i.kind === "raw") : evidence.images.filter((i) => i.crop_id === target.crop_id);
}

async function loadBenchmark(benchmark: IAuditBenchmark): Promise<IBenchmarkData> {
  const members = await allRows<Pick<IBenchmarkTarget, "id" | "dataset_id" | "crop_id" | "split">>((from, to) =>
    audit().from("benchmark_members").select("id, dataset_id, crop_id, split").eq("benchmark_id", benchmark.id).order("id").range(from, to),
  );
  const cropIds = members.map((m) => m.crop_id).filter((id): id is number => id !== null);
  const datasetIds = [...new Set(members.map((m) => m.dataset_id))];
  const onCrops = cropIds.length > 0;
  const ids = onCrops ? cropIds : datasetIds;
  const column = onCrops ? "crop_id" : "dataset_id";
  const assessments = (view: "latest_assessments" | "assessments", kinds: string[]) =>
    byIds<IAuditAssessment>(ids, (chunk, from, to) => {
      // imported old audits are no benchmark truth (docs/audit-checks.md); models never set it
      const query = audit()
        .from(view)
        .select(ASSESSMENT_COLUMNS)
        .eq("check_key", benchmark.check_key)
        .in("assessor_kind", kinds)
        .is("imported_from", null)
        .in(column, chunk);
      return (onCrops ? query : query.is("crop_id", null)).order("id").range(from, to);
    });
  // the target crops; a dataset target shows its evaluation crops only, not the prediction check's many crops
  const crops = await byIds<CropRow>(ids, (chunk, from, to) =>
    (onCrops
      ? audit().from("crops").select(CROP_COLUMNS).in("id", chunk)
      : audit().from("crops").select(CROP_COLUMNS).in("dataset_id", chunk).contains("crop_sets", ["evaluation"])
    )
      .order("id")
      .range(from, to),
  );
  const [images, people, models, current] = await Promise.all([
    onCrops
      ? byIds<IAuditImage>(cropIds, (chunk, from, to) => audit().from("images").select(IMAGE_COLUMNS).in("crop_id", chunk).order("id").range(from, to))
      : Promise.all([
          byIds<IAuditImage>(datasetIds, (chunk, from, to) =>
            audit().from("images").select(IMAGE_COLUMNS).in("dataset_id", chunk).is("crop_id", null).order("id").range(from, to),
          ),
          byIds<IAuditImage>(
            crops.map((c) => c.id),
            (chunk, from, to) => audit().from("images").select(IMAGE_COLUMNS).in("crop_id", chunk).eq("kind", "raw").order("id").range(from, to),
          ),
        ]).then((parts) => parts.flat()),
    assessments("latest_assessments", ["person"]),
    assessments("assessments", ["model", "rule"]),
    byIds<{ dataset_id: number; run_id: number }>(datasetIds, (chunk, from, to) =>
      audit().from("current_runs").select("dataset_id, run_id").eq("check_key", benchmark.check_key).in("dataset_id", chunk).order("dataset_id").range(from, to),
    ),
  ]);
  const currentRuns = new Map(current.map((c) => [c.dataset_id, c.run_id]));
  const labelRuns = new Map(members.map((m) => [m.id, labelRun(m, currentRuns, models)]));
  const runIds = [...new Set([...labelRuns.values()].filter((id): id is number => id !== null))];
  const [named, runs] = await Promise.all([
    withEmails(people),
    byIds<IAuditRun>(runIds, (chunk, from, to) => audit().from("runs").select("id, check_key, inputs, evidence").in("id", chunk).order("id").range(from, to)),
  ]);
  const runById = new Map(runs.map((r) => [r.id, r]));
  const latestModels = latestPerAssessor(models);
  return {
    benchmark,
    targets: members.map((m) => {
      const run = runById.get(labelRuns.get(m.id) ?? -1);
      return {
        ...m,
        run_id: run?.id ?? null,
        images: run ? runImages(m, run, { models, crops, images }) : targetImages(m, images),
        people: named.filter((r) => isOnTarget(m, r)),
        models: latestModels.filter((r) => isOnTarget(m, r)),
      };
    }),
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
