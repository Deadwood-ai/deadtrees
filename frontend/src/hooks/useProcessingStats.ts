import { useQuery } from "@tanstack/react-query";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Settings } from "../config";

export interface IProcessingStats {
  totalTiles: number;
  completed: number;
  inProgress: number;
  pending: number;
  errors: number;
  percentComplete: number;
}

// Check if sentinel credentials are configured
export const isSentinelConfigured = Boolean(Settings.SUPABASE_SENTINEL_URL && Settings.SUPABASE_SENTINEL_ANON_KEY);

// Debug: log configuration status
console.debug("[ProcessingStats] Sentinel configured:", isSentinelConfigured, {
  hasUrl: Boolean(Settings.SUPABASE_SENTINEL_URL),
  hasKey: Boolean(Settings.SUPABASE_SENTINEL_ANON_KEY),
});

// Create client only if configured
let supabaseSentinel: SupabaseClient | null = null;
if (isSentinelConfigured) {
  supabaseSentinel = createClient(Settings.SUPABASE_SENTINEL_URL, Settings.SUPABASE_SENTINEL_ANON_KEY);
}

// Europe UTM zones: 32628-32638 (zones 28N to 38N)
const EUROPE_UTM_MIN = 32628;
const EUROPE_UTM_MAX = 32638;

async function fetchProcessingStats(): Promise<IProcessingStats> {
  if (!supabaseSentinel) {
    throw new Error("Sentinel processing not configured");
  }

  // Use count queries (head: true) to get accurate counts without row limits
  const baseQuery = () =>
    supabaseSentinel
      .from("chunks")
      .select("*", { count: "exact", head: true })
      .gte("utm_epsg", EUROPE_UTM_MIN)
      .lte("utm_epsg", EUROPE_UTM_MAX);

  const [totalResult, doneResult, downloadingResult, uploadingResult, todoResult, errorResult] = await Promise.all([
    baseQuery(),
    baseQuery().eq("status", "done"),
    baseQuery().eq("status", "downloading"),
    baseQuery().eq("status", "uploading"),
    baseQuery().eq("status", "todo"),
    baseQuery().eq("status", "error"),
  ]);

  if (totalResult.error) {
    throw new Error(`Failed to fetch processing stats: ${totalResult.error.message}`);
  }

  const totalTiles = totalResult.count ?? 0;
  const completed = doneResult.count ?? 0;
  const inProgress = (downloadingResult.count ?? 0) + (uploadingResult.count ?? 0);
  const pending = todoResult.count ?? 0;
  const errors = errorResult.count ?? 0;

  return {
    totalTiles,
    completed,
    inProgress,
    pending,
    errors,
    percentComplete: totalTiles > 0 ? Math.round((completed / totalTiles) * 1000) / 10 : 0,
  };
}

export function useProcessingStats() {
  return useQuery({
    queryKey: ["processingStats", "europe"],
    queryFn: fetchProcessingStats,
    staleTime: 60 * 1000, // Consider data fresh for 1 minute
    refetchInterval: 5 * 60 * 1000, // Refetch every 5 minutes
    enabled: isSentinelConfigured, // Only run if credentials are configured
  });
}
