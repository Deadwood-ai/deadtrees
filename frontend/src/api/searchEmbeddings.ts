import { Settings } from "../config";
import { supabase } from "../hooks/useSupabase";

// Open-vocabulary tile search.
//
// The API turns a free-text query into a CLIP text embedding (a pgvector
// literal); the Postgres RPCs rank datasets / tiles against it. Calling the RPCs
// through supabase-js means row-level security enforces per-user dataset
// visibility automatically.

export interface IDatasetSearchResult {
  dataset_id: number;
  similarity: number;
  tile_count: number;
}

export interface ITileSearchResult {
  id: number;
  similarity: number;
  nodata_fraction: number;
  // GeoJSON Polygon geometry in EPSG:4326.
  geometry: GeoJSON.Polygon;
}

/**
 * Record a search query for analytics (fire-and-forget). user_id is filled from
 * the caller's JWT by the table default; dataset_id is set only for the
 * dataset-scoped tile search. Logging must never break search, so failures are
 * swallowed and the insert is not awaited.
 */
function logSearchQuery(query: string, datasetId: number | null): void {
  void supabase
    .from("v2_search_queries")
    .insert({ query, dataset_id: datasetId })
    .then(({ error }) => {
      if (error) console.debug("search query logging failed", error.message);
    });
}

/** Encode a query string into a pgvector literal via the API. */
export async function embedQuery(query: string): Promise<string> {
  const res = await fetch(`${Settings.API_URL}/search/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`Failed to embed query (${res.status})`);
  }
  const data = (await res.json()) as { embedding: string };
  return data.embedding;
}

/** Rank datasets by their best-matching tile against the query. */
export async function searchDatasets(
  query: string,
  matchCount = 100,
  minSimilarity = 0,
): Promise<IDatasetSearchResult[]> {
  logSearchQuery(query, null);
  const embedding = await embedQuery(query);
  const { data, error } = await supabase.rpc("search_datasets_by_embedding", {
    query_embedding: embedding,
    match_count: matchCount,
    min_similarity: minSimilarity,
  });
  if (error) throw error;
  return (data ?? []) as IDatasetSearchResult[];
}

/** Rank the tiles of a single dataset against the query (for highlighting). */
export async function searchTiles(
  query: string,
  datasetId: number,
  matchCount = 300,
): Promise<ITileSearchResult[]> {
  logSearchQuery(query, datasetId);
  const embedding = await embedQuery(query);
  const { data, error } = await supabase.rpc("search_tiles_by_embedding", {
    query_embedding: embedding,
    p_dataset_id: datasetId,
    match_count: matchCount,
  });
  if (error) throw error;
  return (data ?? []) as ITileSearchResult[];
}
