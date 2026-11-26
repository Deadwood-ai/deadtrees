import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import { ASSESSMENT_COLUMNS, AUDIT_RESULTS_KEY, allRows, audit, unwrap, useSaveAuditAnswers, withEmails, type Rows } from "./useAuditChecks";
import type {
  BenchmarkRef,
  IAuditAnswerInput,
  IAuditAssessment,
  IAuditBenchmark,
  IAuditCrop,
  IAuditImage,
  IAuditRun,
  IBenchmarkData,
  IBenchmarkTarget,
} from "../types/auditChecks";
import { runEvidence } from "../utils/auditChecks";
import { latestLabel, stratified } from "../utils/benchmarkLabels";

/** The benchmarks people label, in the order the tab lists them: prediction quality has one
 * per layer. The key names the benchmark in the labeling page's URL. */
export const BENCHMARKS: (BenchmarkRef & { key: string; title: string })[] = [
  { key: "deadwood", check_key: "prediction_quality", layer: "deadwood", title: "Deadwood prediction" },
  { key: "tree_cover", check_key: "prediction_quality", layer: "forest_cover", title: "Tree cover prediction" },
  { key: "dataset_evaluation", check_key: "dataset_evaluation", layer: null, title: "Dataset evaluation" },
];

const CROP_COLUMNS = "id, dataset_id, crop_sets, ortho_sha256, geometry";
type CropRow = IAuditCrop & { dataset_id: number };
const IMAGE_COLUMNS = "id, crop_id, label_id, kind, storage_path, width, height, ortho_sha256, dataset_id";
// a list filter travels in the URL; 100 ids stay well under its limit
const CHUNK = 100;

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
    crops: loaded.crops.filter((c) => c.dataset_id === target.dataset_id),
    images: loaded.images.filter((i) => i.dataset_id === target.dataset_id),
  });
  return target.crop_id === null ? evidence.images.filter((i) => i.crop_id === null || i.kind === "raw") : evidence.images.filter((i) => i.crop_id === target.crop_id);
}

/** Datasets whose audit decision is exclude (audit.dataset_results: a reviewer's, else the
 * check's). Their crops leave the crop benchmarks while the decision stands; their labels stay. */
async function excludedDatasets(datasetIds: number[]): Promise<Set<number>> {
  const rows = await byIds<{ dataset_id: number }>(datasetIds, (chunk, from, to) =>
    audit().from("dataset_results").select("dataset_id").eq("evaluation_decision", "exclude").in("dataset_id", chunk).order("dataset_id").range(from, to),
  );
  return new Set(rows.map((r) => r.dataset_id));
}

type MemberRow = Pick<IBenchmarkTarget, "id" | "dataset_id" | "crop_id" | "split">;
const members = (benchmark: IAuditBenchmark) =>
  allRows<MemberRow>((from, to) =>
    audit().from("benchmark_members").select("id, dataset_id, crop_id, split").eq("benchmark_id", benchmark.id).order("id").range(from, to),
  );

/** The benchmark's targets in stratified order (one per dataset in turn). A crop benchmark
 * leaves out the crops of datasets the audit excludes while that decision stands; their labels stay. */
async function loadBenchmark(benchmark: IAuditBenchmark): Promise<IBenchmarkData> {
  const rows = await members(benchmark);
  const excluded = benchmark.layer ? await excludedDatasets([...new Set(rows.map((m) => m.dataset_id))]) : new Set<number>();
  const kept = stratified(rows.filter((m) => !excluded.has(m.dataset_id))).map((m) => ({ ...m, member: true }));
  return { benchmark, targets: await loadTargets(benchmark, kept) };
}

/** Benchmark targets, members or not, with their images, label, the models' answers and the run
 * a label on them carries. */
async function loadTargets(benchmark: IAuditBenchmark, members: (MemberRow & { member: boolean })[]): Promise<IBenchmarkTarget[]> {
  if (!members.length) return [];
  const cropIds = members.map((m) => m.crop_id).filter((id): id is number => id !== null);
  const datasetIds = [...new Set(members.map((m) => m.dataset_id))];
  const onCrops = benchmark.layer !== null;
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
      // a layer's benchmark: that layer's rows, and "can't tell" on the crop (layer image)
      const scoped = benchmark.layer ? query.in("layer", [benchmark.layer, "image"]) : query;
      return (onCrops ? scoped : scoped.is("crop_id", null)).order("id").range(from, to);
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
  return members.map((m) => {
    const run = runById.get(labelRuns.get(m.id) ?? -1);
    return {
      ...m,
      run_id: run?.id ?? null,
      images: run ? runImages(m, run, { models, crops, images }) : targetImages(m, images),
      people: latestLabel(named.filter((r) => isOnTarget(m, r))),
      models: latestModels.filter((r) => isOnTarget(m, r)),
    };
  });
}

/** Fisher-Yates: a random order. */
function shuffled<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** One random new target for "Label new random ...", or null when none is left: never in the
 * benchmark yet (any member, also one hidden for its excluded dataset). A crop benchmark draws a
 * random dataset first, then one of the crops the check's current run judged on it (so every
 * dataset is equally likely, however many crops it has), skipping datasets the audit excludes;
 * the dataset evaluation draws a dataset it has a current run on. Skipped targets (crop or
 * dataset ids) are not drawn again. */
async function sampleCandidate(benchmark: IAuditBenchmark, skipped: Set<number>): Promise<IBenchmarkTarget | null> {
  const [rows, current] = await Promise.all([
    members(benchmark),
    allRows<{ dataset_id: number; run_id: number }>((from, to) =>
      audit().from("current_runs").select("dataset_id, run_id").eq("check_key", benchmark.check_key).order("dataset_id").range(from, to),
    ),
  ]);
  const load = async (dataset_id: number, crop_id: number | null) =>
    (await loadTargets(benchmark, [{ id: -(crop_id ?? dataset_id), dataset_id, crop_id, split: null, member: false }]))[0];
  if (!benchmark.layer) {
    const taken = new Set([...rows.map((m) => m.dataset_id), ...skipped]);
    const [pick] = shuffled(current.filter((c) => !taken.has(c.dataset_id)));
    return pick ? load(pick.dataset_id, null) : null;
  }
  const taken = new Set([...rows.map((m) => m.crop_id), ...skipped]);
  const pool = shuffled(current);
  // a few random datasets at a time, until one has a crop left to offer
  for (let at = 0; at < pool.length; at += 5) {
    const chunk = pool.slice(at, at + 5);
    const excluded = await excludedDatasets(chunk.map((c) => c.dataset_id));
    const kept = chunk.filter((c) => !excluded.has(c.dataset_id));
    if (!kept.length) continue;
    const runs = await byIds<{ id: number; source_run_id: number | null }>(
      kept.map((c) => c.run_id),
      (ids, from, to) => audit().from("runs").select("id, source_run_id").in("id", ids).order("id").range(from, to),
    );
    const judged = await byIds<{ dataset_id: number; crop_id: number }>(
      runs.map((r) => r.source_run_id ?? r.id),
      (ids, from, to) =>
        audit()
          .from("assessments")
          .select("dataset_id, crop_id")
          .in("run_id", ids)
          .eq("assessor_kind", "model")
          .eq("layer", benchmark.layer!)
          .not("crop_id", "is", null)
          .order("id")
          .range(from, to),
    );
    for (const c of kept) {
      const crops = [...new Set(judged.filter((j) => j.dataset_id === c.dataset_id && !taken.has(j.crop_id)).map((j) => j.crop_id))];
      if (crops.length) return load(c.dataset_id, crops[Math.floor(Math.random() * crops.length)]);
    }
  }
  return null;
}

const benchmarksKey = ["audit-benchmarks"];
export const benchmarkKey = (id: number | undefined) => ["audit-benchmark", id];

/** The open version of each benchmark (one at most per check and layer), auditors only. */
export function useOpenBenchmarks() {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: benchmarksKey,
    queryFn: async () =>
      unwrap(await audit().from("benchmarks").select("id, check_key, layer, name, version").is("frozen_at", null)) as IAuditBenchmark[],
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

export const candidateKey = (id: number | undefined) => ["audit-benchmark-candidate", id];

/** A random new target to label (sampleCandidate): next() draws another once it is labeled,
 * skip() draws another and leaves this one out for the rest of the visit. */
export function useBenchmarkCandidate(benchmark: IAuditBenchmark | undefined, enabled: boolean) {
  const skipped = useRef(new Set<number>());
  const query = useQuery({
    queryKey: candidateKey(benchmark?.id),
    queryFn: () => sampleCandidate(benchmark!, skipped.current),
    enabled: enabled && !!benchmark,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const next = () => query.refetch();
  const skip = () => {
    const target = query.data;
    if (target) skipped.current.add(target.crop_id ?? target.dataset_id);
    return query.refetch();
  };
  return { ...query, next, skip };
}

/** Stores a label on a benchmark target (new person rows) and makes it the target's label. A
 * random new target joins the benchmark only once its label is stored
 * (audit.add_benchmark_target, operators), so no target is ever in it without a label. */
export function useSaveBenchmarkLabel(benchmark: IAuditBenchmark | undefined) {
  const benchmarkId = benchmark?.id;
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { mutateAsync, isPending } = useSaveAuditAnswers();
  /** Throws when the label was not stored; resolves false when it was, but a new target could
   * not join the benchmark. */
  const save = async (target: IBenchmarkTarget, answers: IAuditAnswerInput[]) => {
    // yours: the label says who gave it
    const rows = (await mutateAsync(answers)).map((r) => ({ ...r, assessor_email: r.assessor_email ?? user?.email ?? null }));
    const labeled = (t: IBenchmarkTarget) => {
      const added = rows.filter((r) => isOnTarget(t, r));
      return added.length ? { ...t, people: latestLabel([...t.people, ...added]) } : t;
    };
    let joined = true;
    if (!target.member && benchmark) {
      const { error } = await audit().rpc("add_benchmark_target", {
        p_check_key: benchmark.check_key,
        p_layer: benchmark.layer,
        p_dataset_id: target.dataset_id,
        p_crop_id: target.crop_id,
      });
      joined = !error;
    }
    queryClient.setQueryData<IBenchmarkTarget | null>(candidateKey(benchmarkId), (t) => (t && isOnTarget(t, target) ? { ...labeled(t), member: joined } : t));
    queryClient.setQueryData<IBenchmarkData>(benchmarkKey(benchmarkId), (data) => data && { ...data, targets: data.targets.map(labeled) });
    if (!target.member) {
      // the new member, with its id and split, comes with the next read
      void queryClient.invalidateQueries({ queryKey: benchmarkKey(benchmarkId) });
      void queryClient.invalidateQueries({ queryKey: AUDIT_RESULTS_KEY });
    }
    return joined;
  };
  return { save, isPending };
}

const benchmarkMembershipKey = (datasetId: number | undefined) => ["audit-benchmark-membership", datasetId];

/** Whether a dataset or crop is already a target of its check's open benchmark. */
export function useBenchmarkMembership(datasetId: number | undefined) {
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: benchmarkMembershipKey(datasetId),
    queryFn: async () =>
      unwrap(
        await audit()
          .from("benchmark_members")
          .select("crop_id, benchmark:benchmarks!inner(check_key, layer, frozen_at)")
          .eq("dataset_id", datasetId!)
          .is("benchmark.frozen_at", null),
      ) as unknown as { crop_id: number | null; benchmark: BenchmarkRef }[],
    enabled: !!datasetId && canAudit,
  });
}

type TargetChange = { benchmark: BenchmarkRef; datasetId: number; cropId?: number | null };

/** Adds a crop, or the whole dataset (cropId null), to the open version of a benchmark
 * (audit.add_benchmark_target, operators only). Adding a target that is already in it is a no-op. */
export function useAddBenchmarkTarget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ benchmark, datasetId, cropId = null }: TargetChange) => {
      const { data, error } = await audit().rpc("add_benchmark_target", {
        p_check_key: benchmark.check_key,
        p_layer: benchmark.layer,
        p_dataset_id: datasetId,
        p_crop_id: cropId,
      });
      if (error) throw error;
      return data as { id: number; split: string };
    },
    onSuccess: (_, { datasetId }) => {
      queryClient.invalidateQueries({ queryKey: ["audit-benchmark"] });
      queryClient.invalidateQueries({ queryKey: AUDIT_RESULTS_KEY });
      // awaited: a toggle shows the membership the server holds after its call
      return queryClient.invalidateQueries({ queryKey: benchmarkMembershipKey(datasetId) });
    },
  });
}

/** Takes a crop, or a dataset with all its crops (cropId null), out of the open version of a
 * benchmark again (audit.remove_benchmark_target, operators only). The labels stay, so adding the
 * target back restores it. Removing what is not there removes nothing. */
export function useRemoveBenchmarkTarget(benchmarkId: number | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ benchmark, datasetId, cropId = null }: TargetChange) => {
      const { data, error } = await audit().rpc("remove_benchmark_target", {
        p_check_key: benchmark.check_key,
        p_layer: benchmark.layer,
        p_dataset_id: datasetId,
        p_crop_id: cropId,
      });
      if (error) throw error;
      return (data ?? []) as TargetRef[];
    },
    onSuccess: (removed, { datasetId }) => {
      // the target leaves the loaded benchmark at once; a reload confirms it
      queryClient.setQueryData<IBenchmarkData>(benchmarkKey(benchmarkId), (data) =>
        data && { ...data, targets: data.targets.filter((t) => !removed.some((r) => r.dataset_id === t.dataset_id && r.crop_id === t.crop_id)) },
      );
      queryClient.invalidateQueries({ queryKey: AUDIT_RESULTS_KEY });
      return queryClient.invalidateQueries({ queryKey: benchmarkMembershipKey(datasetId) });
    },
  });
}
