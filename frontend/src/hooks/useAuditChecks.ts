import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { supabase } from "./useSupabase";
import { useAuth } from "./useAuthProvider";
import { useCanAudit } from "./useUserPrivileges";
import { fetchAuditImages } from "../api/auditImages";
import { freshUntilExpiry, refreshBeforeExpiry } from "../utils/signedFilesGrant";
import { unwrap } from "../utils/allRows";
import type {
  AuditCheckKey,
  DatasetReviewInput,
  IAuditChecks,
  IAuditImage,
  IAuditReviews,
  IAuditTile,
  ICurrentRun,
  IDatasetJudgement,
  IDatasetReview,
  ITileCall,
  ITileJudgement,
  ITileReview,
  TileReviewInput,
} from "../types/auditChecks";

export const audit = () => supabase.schema("audit");

/** PostgREST answers this while the audit schema is not in its exposed schemas. */
export const SCHEMA_NOT_EXPOSED = "PGRST106";

export const CURRENT_RUN_COLUMNS = "dataset_id, check_key, run_id";
export const IMAGE_COLUMNS = "id, run_id, dataset_id, tile_id, prediction_label_id, kind, storage_path, width, height";
export const DATASET_JUDGEMENT_COLUMNS = "id, run_id, dataset_id, judge, verdict, cog_issue, thumbnail_issue, exclude_reason, summary";
export const TILE_JUDGEMENT_COLUMNS = "id, run_id, tile_id, layer, judge, verdict, problems, summary";
export const DATASET_REVIEW_COLUMNS =
  "id, dataset_id, check_key, decision, exclude_reason, cog_issue, thumbnail_issue, georef_status, date_replace, note, in_benchmark, reviewed_by, created_at";
/** The newest review per check, its id named as in the table. */
export const CURRENT_REVIEW_COLUMNS =
  "id:review_id, dataset_id, check_key, decision, exclude_reason, cog_issue, thumbnail_issue, georef_status, date_replace, note, in_benchmark, reviewed_by, created_at, stale";
export const TILE_REVIEW_COLUMNS = "id, dataset_id, tile_id, layer, prediction_label_id, verdict, problems, note, in_benchmark, reviewed_by, created_at";

/** Every query on audit.dataset_outcomes starts with this key, so an answer or a benchmark change refreshes them all. */
export const AUDIT_RESULTS_KEY = ["audit-dataset-results"];

export const auditChecksKey = (datasetId: number | undefined) => ["audit-checks", datasetId];
export const auditReviewsKey = (datasetId: number | undefined) => ["audit-reviews", datasetId];
export const benchmarkMembershipKey = (datasetId: number | undefined) => ["audit-benchmark-membership", datasetId];

const NOTHING: IAuditChecks = { available: true, checks: {}, datasetJudgements: [], tileJudgements: [], evaluationJudgementId: null };

async function loadAuditChecks(datasetId: number): Promise<IAuditChecks> {
  const current = await audit().from("current_runs").select(CURRENT_RUN_COLUMNS).eq("dataset_id", datasetId);
  if (current.error?.code === SCHEMA_NOT_EXPOSED) return { ...NOTHING, available: false };
  const runs = unwrap(current) as ICurrentRun[];
  // most datasets have no check yet: one request tells
  if (!runs.length) return NOTHING;
  const runOf = (checkKey: AuditCheckKey) => runs.find((r) => r.check_key === checkKey)?.run_id ?? -1;
  const [images, tiles, datasetJudgements, tileJudgements, evaluationCall] = await Promise.all([
    audit().from("images").select(IMAGE_COLUMNS).in("run_id", runs.map((r) => r.run_id)).order("id"),
    audit().from("tiles").select("id, dataset_id, geometry").eq("dataset_id", datasetId).order("id"),
    audit().from("dataset_vlm_judgements").select(DATASET_JUDGEMENT_COLUMNS).eq("run_id", runOf("dataset_evaluation")),
    audit().from("tile_vlm_judgements").select(TILE_JUDGEMENT_COLUMNS).eq("run_id", runOf("prediction_quality")),
    audit().from("evaluation_calls").select("judgement_id").eq("dataset_id", datasetId),
  ]);
  const allImages = unwrap(images) as IAuditImage[];
  const allTiles = unwrap(tiles) as IAuditTile[];
  const checks: IAuditChecks["checks"] = {};
  for (const run of runs) {
    // a run's images are its own; its tiles are the ones it cut images of
    const own = allImages.filter((i) => i.run_id === run.run_id);
    const tileIds = new Set(own.map((i) => i.tile_id));
    checks[run.check_key] = { run, images: own, tiles: allTiles.filter((t) => tileIds.has(t.id)) };
  }
  return {
    available: true,
    checks,
    datasetJudgements: unwrap(datasetJudgements) as IDatasetJudgement[],
    tileJudgements: unwrap(tileJudgements) as ITileJudgement[],
    evaluationJudgementId: (unwrap(evaluationCall) as { judgement_id: number | null }[])[0]?.judgement_id ?? null,
  };
}

/** Reviewers' emails on their answers (get_user_emails answers auditors only); ids stay when it fails. */
export async function withEmails<T extends { reviewed_by: string | null }>(rows: T[]): Promise<(T & { reviewer_email?: string | null })[]> {
  const ids = [...new Set(rows.map((r) => r.reviewed_by).filter((id): id is string => !!id))];
  if (!ids.length) return rows;
  const { data, error } = await supabase.rpc("get_user_emails", { p_user_ids: ids });
  if (error || !data) return rows;
  const emails = new Map((data as { user_id: string; email: string | null }[]).map((r) => [r.user_id, r.email]));
  return rows.map((r) => ({ ...r, reviewer_email: emails.get(r.reviewed_by ?? "") ?? null }));
}

/** The dataset's automated audit checks: each current run's tiles, images and the models' answers (auditors only). */
export function useAuditChecks(datasetId: number | undefined) {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: auditChecksKey(datasetId),
    queryFn: () => loadAuditChecks(datasetId!),
    enabled: !!datasetId && !!user?.id && canAudit,
  });
}

async function loadAuditReviews(datasetId: number): Promise<IAuditReviews> {
  const [current, calls] = await Promise.all([
    audit().from("current_dataset_human_reviews").select(CURRENT_REVIEW_COLUMNS).eq("dataset_id", datasetId),
    audit().from("tile_calls").select("dataset_id, run_id, tile_id, layer, prediction_label_id, verdict, by_person, review_id, judgement_id").eq("dataset_id", datasetId),
  ]);
  if (current.error?.code === SCHEMA_NOT_EXPOSED) return { datasetReviews: [], tileCalls: [], tileReviews: [] };
  const tileCalls = unwrap(calls) as ITileCall[];
  const reviewIds = tileCalls.map((c) => c.review_id).filter((id): id is number => id !== null);
  const tileReviews = reviewIds.length ? (unwrap(await audit().from("tile_human_reviews").select(TILE_REVIEW_COLUMNS).in("id", reviewIds)) as ITileReview[]) : [];
  const [datasetReviews, namedTileReviews] = await Promise.all([withEmails(unwrap(current) as IDatasetReview[]), withEmails(tileReviews)]);
  return { datasetReviews, tileCalls, tileReviews: namedTileReviews };
}

/** People's answers on the dataset as they count now, and the tile calls they decide (auditors only). */
export function useAuditReviews(datasetId: number | undefined) {
  const { user } = useAuth();
  const { canAudit } = useCanAudit();
  return useQuery({
    queryKey: auditReviewsKey(datasetId),
    queryFn: () => loadAuditReviews(datasetId!),
    enabled: !!datasetId && !!user?.id && canAudit,
  });
}

/** An answer changes the dataset's reviews, what it still needs, what it reports and its benchmark
 * membership; resolves once the dataset's reviews are read again. */
function refreshAfterAnswer(queryClient: QueryClient, datasetId: number) {
  void queryClient.invalidateQueries({ queryKey: AUDIT_RESULTS_KEY });
  void queryClient.invalidateQueries({ queryKey: benchmarkMembershipKey(datasetId) });
  return queryClient.invalidateQueries({ queryKey: auditReviewsKey(datasetId) });
}

/** Stores answers on whole datasets as new reviews (the database adds who and the evidence);
 * earlier ones stay as history, the newest counts. */
export function useSaveDatasetReviews() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (reviews: DatasetReviewInput[]) => {
      if (!user?.id) throw new Error("Sign in to answer");
      // several rows in one insert: a column a row leaves out takes its database default, not null
      const { data, error } = await audit().from("dataset_human_reviews").insert(reviews, { defaultToNull: false }).select(DATASET_REVIEW_COLUMNS);
      if (error) throw error;
      return (data as IDatasetReview[]).map((row) => ({ ...row, reviewer_email: user.email ?? null }));
    },
    onSuccess: (_, reviews) => refreshAfterAnswer(queryClient, reviews[0].dataset_id),
  });
}

/** Stores an answer on a tile and layer as a new review; the newest on the same prediction counts. */
export function useSaveTileReview() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (review: TileReviewInput) => {
      if (!user?.id) throw new Error("Sign in to answer");
      const { data, error } = await audit().from("tile_human_reviews").insert(review).select(TILE_REVIEW_COLUMNS).single();
      if (error) throw error;
      return { ...(data as ITileReview), reviewer_email: user.email ?? null };
    },
    onSuccess: (_, review) => refreshAfterAnswer(queryClient, review.dataset_id),
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
