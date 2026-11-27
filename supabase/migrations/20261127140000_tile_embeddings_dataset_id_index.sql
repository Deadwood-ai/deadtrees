-- A dataset's CLIP tiles in id order, a page at a time (stored_inputs.tile_rows). With the
-- dataset index alone Postgres walked the primary key through other datasets' tiles, or read
-- and sorted all of a dataset's tiles for every page: past the statement timeout for a
-- dataset of 53 000 tiles. Built concurrently in its own migration so the embedding stage
-- keeps writing; the Supabase CLI applies a file without an explicit transaction outside a
-- transaction block. A failed concurrent build leaves an invalid index; the retry then fails
-- on the existing name (no IF NOT EXISTS) until an operator drops it.
create index concurrently v2_tile_embeddings_dataset_id_id_idx on public.v2_tile_embeddings (dataset_id, id);
