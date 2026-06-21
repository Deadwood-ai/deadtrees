-- Track completion of the open-vocabulary tile embedding stage. The
-- embeddings_v1 task computes per-tile CLIP embeddings (stored in
-- v2_tile_embeddings) used for open-vocabulary search and tile highlighting.
alter table public.v2_statuses
  add column if not exists is_embeddings_done boolean not null default false;
