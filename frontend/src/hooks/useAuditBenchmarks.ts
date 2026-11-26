import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import {
  AUDIT_RESULTS_KEY,
  CURRENT_REVIEW_COLUMNS,
  CURRENT_RUN_COLUMNS,
  DATASET_JUDGEMENT_COLUMNS,
  IMAGE_COLUMNS,
  TILE_JUDGEMENT_COLUMNS,
  TILE_REVIEW_COLUMNS,
  allRows,
  audit,
  benchmarkMembershipKey,
  unwrap,
  useSaveDatasetReviews,
  useSaveTileReview,
  withEmails,
  type Rows,
} from "./useAuditChecks";
import type {
  DatasetReviewInput,
  IAuditImage,
  ICurrentRun,
  IDatasetJudgement,
  IDatasetReview,
  ITileJudgement,
  ITileReview,
  PredictionLayer,
  TileReviewInput,
} from "../types/auditChecks";
import { BENCHMARKS, stratified, tileImages, type BenchmarkKey, type IBenchmarkTarget, type IDatasetTarget, type ITileTarget } from "../utils/benchmarkLabels";

// a list filter travels in the URL; 100 ids stay well under its limit
const CHUNK = 100;

/** Every row for many ids: a chunk of ids per query, each read to the end. */
async function byIds<T>(ids: number[], page: (chunk: number[], from: number, to: number) => Rows<T>): Promise<T[]> {
  const chunks = Array.from({ length: Math.ceil(ids.length / CHUNK) }, (_, i) => ids.slice(i * CHUNK, (i + 1) * CHUNK));
  const parts = await Promise.all(chunks.map((chunk) => allRows<T>((from, to) => page(chunk, from, to))));
  return parts.flat();
}

const unique = (ids: number[]) => [...new Set(ids)];
const layerOf = (key: BenchmarkKey) => BENCHMARKS.find((b) => b.key === key)!.layer;

/** Datasets whose audit decision is exclude (audit.dataset_outcomes). Their tiles leave the tile
 * benchmarks while the decision stands; their labels stay. */
async function excludedDatasets(datasetIds: number[]): Promise<Set<number>> {
  const rows = await byIds<{ dataset_id: number }>(datasetIds, (chunk, from, to) =>
    audit().from("dataset_outcomes").select("dataset_id").eq("evaluation_decision", "exclude").in("dataset_id", chunk).order("dataset_id").range(from, to),
  );
  return new Set(rows.map((r) => r.dataset_id));
}

/** Datasets with their newest dataset evaluation review as label, and the current dataset
 * evaluation run's images and model answers. */
async function loadDatasetTargets(datasetIds: number[]): Promise<IDatasetTarget[]> {
  if (!datasetIds.length) return [];
  const [labels, runs] = await Promise.all([
    byIds<IDatasetReview>(datasetIds, (chunk, from, to) =>
      audit().from("current_dataset_human_reviews").select(CURRENT_REVIEW_COLUMNS).eq("check_key", "dataset_evaluation").in("dataset_id", chunk).order("dataset_id").range(from, to),
    ),
    byIds<ICurrentRun>(datasetIds, (chunk, from, to) =>
      audit().from("current_runs").select(CURRENT_RUN_COLUMNS).eq("check_key", "dataset_evaluation").in("dataset_id", chunk).order("dataset_id").range(from, to),
    ),
  ]);
  const runIds = runs.map((r) => r.run_id);
  const [images, models, named] = await Promise.all([
    byIds<IAuditImage>(runIds, (chunk, from, to) => audit().from("images").select(IMAGE_COLUMNS).in("run_id", chunk).order("id").range(from, to)),
    byIds<IDatasetJudgement>(runIds, (chunk, from, to) => audit().from("dataset_vlm_judgements").select(DATASET_JUDGEMENT_COLUMNS).in("run_id", chunk).order("id").range(from, to)),
    withEmails(labels),
  ]);
  return datasetIds.map((id) => {
    const run = runs.find((r) => r.dataset_id === id)?.run_id;
    return {
      id,
      dataset_id: id,
      tile_id: null,
      label: named.find((l) => l.dataset_id === id) ?? null,
      images: images.filter((i) => i.run_id === run),
      models: models.filter((m) => m.run_id === run),
    };
  });
}

/** Tiles with their newest review on the layer as label, the images of the newest run that judged
 * them, and that run's model answers. */
async function loadTileTargets(layer: PredictionLayer, refs: { dataset_id: number; tile_id: number }[]): Promise<ITileTarget[]> {
  if (!refs.length) return [];
  const tileIds = refs.map((r) => r.tile_id);
  const [reviews, images, models] = await Promise.all([
    byIds<ITileReview>(tileIds, (chunk, from, to) =>
      audit().from("tile_human_reviews").select(TILE_REVIEW_COLUMNS).eq("layer", layer).in("tile_id", chunk).order("id", { ascending: false }).range(from, to),
    ),
    byIds<IAuditImage>(tileIds, (chunk, from, to) => audit().from("images").select(IMAGE_COLUMNS).in("tile_id", chunk).order("id").range(from, to)),
    byIds<ITileJudgement>(tileIds, (chunk, from, to) =>
      audit().from("tile_vlm_judgements").select(TILE_JUDGEMENT_COLUMNS).eq("layer", layer).in("tile_id", chunk).order("id").range(from, to),
    ),
  ]);
  // the newest review per tile comes first
  const labels = await withEmails(tileIds.flatMap((id) => reviews.find((r) => r.tile_id === id) ?? []));
  return refs.map(({ dataset_id, tile_id }) => {
    const label = labels.find((l) => l.tile_id === tile_id) ?? null;
    const shown = tileImages(images.filter((i) => i.tile_id === tile_id), layer, label?.prediction_label_id);
    const run = shown[0]?.run_id;
    return {
      id: tile_id,
      dataset_id,
      tile_id,
      label,
      images: shown,
      models: models.filter((m) => m.tile_id === tile_id && m.run_id === run),
      prediction_label_id: shown.find((i) => i.kind !== "raw")?.prediction_label_id ?? null,
    };
  });
}

/** A benchmark's targets: the datasets or tiles with a review ticked in_benchmark, in stratified
 * order (one per dataset in turn). A tile benchmark leaves out the tiles of datasets the audit
 * excludes while that decision stands; their labels stay. */
async function loadBenchmark(key: BenchmarkKey): Promise<IBenchmarkTarget[]> {
  const layer = layerOf(key);
  if (!layer) {
    const ticked = await allRows<{ dataset_id: number }>((from, to) =>
      audit().from("dataset_human_reviews").select("dataset_id").eq("check_key", "dataset_evaluation").eq("in_benchmark", true).order("dataset_id").range(from, to),
    );
    return loadDatasetTargets(unique(ticked.map((t) => t.dataset_id)));
  }
  const ticked = await allRows<{ dataset_id: number; tile_id: number }>((from, to) =>
    audit().from("tile_human_reviews").select("dataset_id, tile_id").eq("layer", layer).eq("in_benchmark", true).order("tile_id").range(from, to),
  );
  const tiles = unique(ticked.map((t) => t.tile_id)).map((id) => ticked.find((t) => t.tile_id === id)!);
  const excluded = await excludedDatasets(unique(tiles.map((t) => t.dataset_id)));
  return loadTileTargets(layer, stratified(tiles.filter((t) => !excluded.has(t.dataset_id))));
}

/** One random new target for "Label new random ...", or null when none is left (audit.draw_target:
 * not in the benchmark yet, not skipped; a tile of a random dataset the audit keeps). It is shown
 * unlabeled, so the labeler answers blind. */
async function drawTarget(key: BenchmarkKey, skipped: number[]): Promise<IBenchmarkTarget | null> {
  const { data, error } = await audit().rpc("draw_target", { p_benchmark: key, p_skipped: skipped });
  if (error) throw error;
  const [pick] = (data ?? []) as { dataset_id: number; tile_id: number | null }[];
  if (!pick) return null;
  const layer = layerOf(key);
  const [target] =
    layer && pick.tile_id !== null ? await loadTileTargets(layer, [{ dataset_id: pick.dataset_id, tile_id: pick.tile_id }]) : await loadDatasetTargets([pick.dataset_id]);
  return target ? { ...target, label: null } : null;
}

export const benchmarkKey = (key: BenchmarkKey) => ["audit-benchmark", key];
const candidateKey = (key: BenchmarkKey) => ["audit-benchmark-candidate", key];

/** One benchmark's targets with their labels, images and the models' answers (auditors only). */
export function useBenchmark(key: BenchmarkKey) {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: benchmarkKey(key),
    queryFn: () => loadBenchmark(key),
    enabled: !!user?.id && canAudit,
    staleTime: 60_000,
  });
}

/** A random new target to label: next() draws another once it is labeled, skip() draws another
 * and leaves this one out for the rest of the visit. */
export function useBenchmarkCandidate(key: BenchmarkKey, enabled: boolean) {
  const skipped = useRef(new Set<number>());
  const query = useQuery({
    queryKey: candidateKey(key),
    queryFn: () => drawTarget(key, [...skipped.current]),
    enabled,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const next = () => query.refetch();
  const skip = () => {
    if (query.data) skipped.current.add(query.data.id);
    return query.refetch();
  };
  return { ...query, next, skip };
}

const sameTarget = (a: { dataset_id: number; tile_id: number | null }, b: { dataset_id: number; tile_id: number | null }) =>
  a.dataset_id === b.dataset_id && a.tile_id === b.tile_id;

/** Stores a label: the answer as a review ticked in_benchmark (operators), which makes it the
 * target's label and puts the target into the benchmark. */
export function useSaveBenchmarkLabel(key: BenchmarkKey) {
  const queryClient = useQueryClient();
  const saveDataset = useSaveDatasetReviews();
  const saveTile = useSaveTileReview();
  const save = async (target: IBenchmarkTarget, review: DatasetReviewInput | TileReviewInput) => {
    const label = "tile_id" in review ? await saveTile.mutateAsync({ ...review, in_benchmark: true }) : (await saveDataset.mutateAsync([{ ...review, in_benchmark: true }]))[0];
    const labeled = <T extends IBenchmarkTarget>(t: T): T => (sameTarget(t, target) ? { ...t, label } : t);
    queryClient.setQueryData<IBenchmarkTarget | null>(candidateKey(key), (t) => t && labeled(t));
    const listed = queryClient.getQueryData<IBenchmarkTarget[]>(benchmarkKey(key))?.some((t) => sameTarget(t, target));
    if (listed) queryClient.setQueryData<IBenchmarkTarget[]>(benchmarkKey(key), (targets) => targets?.map(labeled));
    // a target new to the benchmark comes with the next read
    else void queryClient.invalidateQueries({ queryKey: benchmarkKey(key) });
  };
  return { save, isPending: saveDataset.isPending || saveTile.isPending };
}

/** The answer a label holds, to store it again (Undo of a removal). */
export function labelInput(target: IBenchmarkTarget, layer: PredictionLayer | null): DatasetReviewInput | TileReviewInput | null {
  if (!target.label) return null;
  const { dataset_id, note } = target.label;
  if (target.tile_id === null) {
    const { decision, exclude_reason, cog_issue, thumbnail_issue } = target.label as IDatasetReview;
    return { dataset_id, check_key: "dataset_evaluation", decision, exclude_reason, cog_issue, thumbnail_issue, note };
  }
  const { verdict, problems, prediction_label_id } = target.label as ITileReview;
  return { dataset_id, tile_id: target.tile_id, layer: layer!, prediction_label_id, verdict, problems, note };
}

/** Whether a dataset and its tiles are in the benchmarks: a review of them ticked in_benchmark. */
export function useBenchmarkMembership(datasetId: number | undefined) {
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: benchmarkMembershipKey(datasetId),
    queryFn: async () => {
      const [dataset, tiles] = await Promise.all([
        audit().from("dataset_human_reviews").select("id").eq("dataset_id", datasetId!).eq("check_key", "dataset_evaluation").eq("in_benchmark", true).limit(1),
        audit().from("tile_human_reviews").select("tile_id, layer").eq("dataset_id", datasetId!).eq("in_benchmark", true),
      ]);
      return { dataset: unwrap(dataset).length > 0, tiles: unwrap(tiles) as { tile_id: number; layer: PredictionLayer }[] };
    },
    enabled: !!datasetId && canAudit,
  });
}

type TargetRef = { dataset_id: number; tile_id: number | null };

/** Takes targets out of a benchmark (audit.remove_benchmark_target, operators only): their
 * reviews lose the tick and stay as reviews. */
export function useRemoveBenchmarkTargets(key: BenchmarkKey) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (targets: TargetRef[]) => {
      const results = await Promise.all(
        targets.map((t) => audit().rpc("remove_benchmark_target", { p_benchmark: key, p_dataset_id: t.dataset_id, p_tile_id: t.tile_id })),
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw failed.error;
      return targets;
    },
    onSuccess: (removed) => {
      // the targets leave the loaded benchmark at once; a reload confirms it
      queryClient.setQueryData<IBenchmarkTarget[]>(benchmarkKey(key), (targets) => targets?.filter((t) => !removed.some((r) => sameTarget(r, t))));
      void queryClient.invalidateQueries({ queryKey: AUDIT_RESULTS_KEY });
      return Promise.all(unique(removed.map((r) => r.dataset_id)).map((id) => queryClient.invalidateQueries({ queryKey: benchmarkMembershipKey(id) })));
    },
  });
}
