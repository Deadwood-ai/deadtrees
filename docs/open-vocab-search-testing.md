# Open-vocabulary tile search — testing guide

Adds CLIP-based open-vocabulary search over orthophoto tiles: rank datasets by a
free-text query, highlight matching tiles on the map, and search within a single
orthophoto. Branch: `feat/open-vocab-tile-search`.

## How ranking works

1. **Indexing (processor, `embeddings_v1` task).** Each orthophoto is reprojected
   to a uniform **10 cm** GSD, tiled into non-overlapping **512×512** windows,
   tiles with **>50 % nodata are dropped**, and the rest are embedded with
   **OpenCLIP ViT-H/14** (1024-d, L2-normalized). Each tile is stored in
   `v2_tile_embeddings` with its WGS84 footprint.
2. **Query (API `POST /search/embed`).** The text query is encoded with the same
   model into a 1024-d vector (a pgvector literal).
3. **Dataset ranking (`search_datasets_by_embedding`).** Each dataset is scored
   by its **single best-matching tile** — `max(1 − cosine_distance)` over that
   dataset's tiles — and datasets are returned ordered by that score. So a
   dataset ranks high if *any one tile* strongly matches the query.
4. **Tile ranking / highlight (`search_tiles_by_embedding`).** For one dataset,
   tiles are returned ordered by similarity with their GeoJSON footprints; the
   frontend draws them as highlight rectangles (opacity ∝ relevance) and zooms to
   the best tile.

RLS is enforced by calling the RPCs directly from the browser with the user's
session, so private datasets stay hidden.

## Model weights

Provisioned like the segmentation models: a local checkpoint at
`assets/models/openclip_vith14_laion2b_s32b_b79k.safetensors` (git-ignored,
bind-mounted at runtime). The processor and API run on **different servers**, so
each needs its own copy. `shared/embedding_model.py` loads this file when
present (no network); otherwise it downloads the `laion2b_s32b_b79k` tag once
into the persistent `OPENCLIP_CACHE_DIR` (`/data/assets/openclip_cache`).

## Quick test WITHOUT a database (ranking only)

```bash
# 1. Precompute tile embeddings for some orthos -> NDJSON (uses the local model)
python scripts/dump_embeddings.py 204:/path/204_postfire.tif 211:/path/211_auwald.tif

# 2. Rank datasets/tiles for queries (mirrors the SQL RPCs exactly)
python scripts/search_demo.py "fire" "river" "railway tracks"
```

## Full UI test (local stack, precomputed embeddings, no segmentation models)

```bash
# 0. Bring up the isolated env and apply migrations (incl. the 3 new ones)
scripts/qa/env.sh up && scripts/qa/env.sh reset    # runs supabase db reset
source .local/supabase/current.env                 # exports SUPABASE_DB_URL, etc.

# 1. Generate + apply the seed (2 demo datasets + their tile embeddings)
python scripts/seed_tile_embeddings.py             # -> /tmp/seed_tile_embeddings.sql
psql "$SUPABASE_DB_URL" -f /tmp/seed_tile_embeddings.sql

# 2. Start the API (loads the local CLIP weights for /search/embed)
docker compose -f docker-compose.api.yaml up   # or: cd api && python run.py server

# 3. Start the frontend pointed at the local supabase + API
cd frontend && npm run dev:local
```

Then on `/dataset`:
- Type a query in the **AI search** box → the list reorders by `% match`.
- **Middle-click** (or Ctrl/Cmd-click) a row → opens the dataset in a new tab.
- Click a ranked row → detail page opens with the query forwarded (`?q=`) and the
  best-matching tiles highlighted; the **Search this orthophoto** box runs the
  same search scoped to that ortho. The highlight clears via the input/clear
  button.

> The seed does not include COG imagery, so the detail map shows the basemap with
> highlight rectangles at the tiles' real coordinates rather than the drone ortho.
> That is sufficient to exercise ranking, highlighting, and per-ortho search.
