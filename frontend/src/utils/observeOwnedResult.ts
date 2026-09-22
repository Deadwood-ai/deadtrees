import { supabase } from "../hooks/useSupabase";
import type { IDataset } from "../types/dataset";
import { canCaptureEvents } from "./analytics";

type ResultObservation = Pick<IDataset, "id" | "user_id" | "is_combined_model_done" | "is_deadwood_done" | "is_forest_cover_done">;

/** Optional analytics: a consented owner visit, never an operator inspection. */
export async function observeOwnedResult(dataset: ResultObservation | null | undefined, userId: string | undefined): Promise<void> {
  if (!dataset || !userId || dataset.user_id !== userId || !canCaptureEvents()) return;
  if (!dataset.is_combined_model_done && !(dataset.is_deadwood_done && dataset.is_forest_cover_done)) return;
  try {
    // The server validates full readiness and ownership and timestamps the first
    // observation once. Telemetry failure must never prevent viewing a result.
    await supabase.rpc("factory_record_result_view", { p_dataset_id: dataset.id });
  } catch {
    // No retries or user-facing error for optional analytics.
  }
}
