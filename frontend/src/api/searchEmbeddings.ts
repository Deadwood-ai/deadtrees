import { Settings } from "../config";
import { supabase } from "../hooks/useSupabase";

// Open-vocabulary search is deliberately split across two boundaries:
// the public, rate-limited API embeds text; the authenticated Supabase RPC
// ranks only datasets visible to the caller and currently requires can_audit().

export interface IDatasetSearchResult {
  dataset_id: number;
  similarity: number;
  tile_count: number;
}

export interface ITileSearchResult {
  id: number;
  similarity: number;
  nodata_fraction: number;
  geometry: GeoJSON.Polygon;
}

/** Encode a query string into a pgvector literal via the public API. */
export async function embedQuery(query: string): Promise<string> {
  const response = await fetch(`${Settings.API_URL}/search/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: string;
    } | null;
    throw new Error(
      payload?.detail ?? `Failed to embed query (${response.status})`,
    );
  }
  const data = (await response.json()) as { embedding: string };
  return data.embedding;
}

/**
 * Best-effort analytics for successful privileged searches. RLS accepts only
 * auditor-owned rows. Logging failures never turn a valid search into an error.
 */
function logSuccessfulSearch(query: string, datasetId: number | null): void {
  void supabase
    .from("v2_search_queries")
    .insert({ query, dataset_id: datasetId })
    .then(({ error }) => {
      if (error) console.debug("search query logging failed", error.message);
    });
}

/** Rank datasets visible to the authenticated auditor. */
export async function searchDatasets(
  query: string,
  matchCount = 100,
  minSimilarity = 0,
): Promise<IDatasetSearchResult[]> {
  const embedding = await embedQuery(query);
  const { data, error } = await supabase.rpc("search_datasets_by_embedding", {
    query_embedding: embedding,
    match_count: matchCount,
    min_similarity: minSimilarity,
  });
  if (error) throw new Error(error.message || "Dataset search failed");
  logSuccessfulSearch(query, null);
  return (data ?? []) as IDatasetSearchResult[];
}

/** Rank visible in-AOI tiles of one dataset for the authenticated auditor. */
export async function searchTiles(
  query: string,
  datasetId: number,
  matchCount = 300,
): Promise<ITileSearchResult[]> {
  const embedding = await embedQuery(query);
  const { data, error } = await supabase.rpc("search_tiles_by_embedding", {
    query_embedding: embedding,
    p_dataset_id: datasetId,
    match_count: matchCount,
  });
  if (error) throw new Error(error.message || "Tile search failed");
  logSuccessfulSearch(query, datasetId);
  return (data ?? []) as ITileSearchResult[];
}
