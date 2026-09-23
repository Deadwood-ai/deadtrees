import { Settings } from "../config";
import { supabase } from "../hooks/useSupabase";

// Open-vocabulary search is deliberately split across two boundaries:
// the public, rate-limited API embeds text; the public Supabase RPC ranks only
// datasets visible to the caller (anonymous visitors included).
//
// Query-text analytics belong to the first boundary: the API logs the query it
// served with its service role. The browser never writes the log itself, which
// is what lets public queries be recorded without exposing the table to anyone
// holding the (public) anon key.

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

/**
 * Encode a query string into a pgvector literal via the public API.
 *
 * `datasetId` scopes the query in the API's analytics log; it is null for the
 * global archive search. The bearer token is sent when the visitor happens to
 * be signed in, so the log can attribute the query - the endpoint itself is
 * public and serves anonymous callers the same way.
 */
export async function embedQuery(
  query: string,
  datasetId: number | null = null,
): Promise<string> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  const response = await fetch(`${Settings.API_URL}/search/embed`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ query, dataset_id: datasetId }),
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

/** Rank datasets visible to the caller. */
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
  return (data ?? []) as IDatasetSearchResult[];
}

/** Rank visible in-AOI tiles of one dataset. */
export async function searchTiles(
  query: string,
  datasetId: number,
  matchCount = 300,
): Promise<ITileSearchResult[]> {
  const embedding = await embedQuery(query, datasetId);
  const { data, error } = await supabase.rpc("search_tiles_by_embedding", {
    query_embedding: embedding,
    p_dataset_id: datasetId,
    match_count: matchCount,
  });
  if (error) throw new Error(error.message || "Tile search failed");
  return (data ?? []) as ITileSearchResult[];
}
