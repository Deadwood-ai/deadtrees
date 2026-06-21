import { Settings } from "../config";
import { supabase } from "../hooks/useSupabase";

// Open-vocabulary tile search.
//
// The API turns a free-text query into a CLIP text embedding (a pgvector
// literal); the Postgres RPCs rank datasets / tiles against it. Calling the RPCs
// through supabase-js means row-level security enforces per-user dataset
// visibility automatically.

export interface DatasetSearchResult {
  dataset_id: number;
  similarity: number;
  tile_count: number;
}

export interface TileSearchResult {
  id: number;
  similarity: number;
  nodata_fraction: number;
  // GeoJSON Polygon geometry in EPSG:4326.
  geometry: GeoJSON.Polygon;
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
): Promise<DatasetSearchResult[]> {
  const embedding = await embedQuery(query);
  const { data, error } = await supabase.rpc("search_datasets_by_embedding", {
    query_embedding: embedding,
    match_count: matchCount,
    min_similarity: minSimilarity,
  });
  if (error) throw error;
  return (data ?? []) as DatasetSearchResult[];
}

/** Rank the tiles of a single dataset against the query (for highlighting). */
export async function searchTiles(
  query: string,
  datasetId: number,
  matchCount = 300,
): Promise<TileSearchResult[]> {
  const embedding = await embedQuery(query);
  const { data, error } = await supabase.rpc("search_tiles_by_embedding", {
    query_embedding: embedding,
    p_dataset_id: datasetId,
    match_count: matchCount,
  });
  if (error) throw error;
  return (data ?? []) as TileSearchResult[];
}
