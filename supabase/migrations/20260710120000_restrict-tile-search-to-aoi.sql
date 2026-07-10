-- Restrict open-vocabulary tile/dataset search to each dataset's AOI.
--
-- Tile embeddings cover the whole reprojected orthophoto, but a dataset's labelled
-- region is its AOI (v2_aois). Matching on tiles outside the AOI surfaces
-- background/irrelevant content, so search should only consider in-AOI tiles.
--
-- Doing the ST_Intersects on the fly is cheap for simple hand-drawn AOIs but scales
-- as (tiles x AOI-vertices); model-generated AOIs now reach ~11k vertices, pushing a
-- naive filter into hundreds of ms (per-dataset) to seconds (the /datasets HNSW
-- search over ~500 candidates). And writing an in_aoi flag directly onto
-- v2_tile_embeddings would churn/bloat the HNSW index on every AOI edit (the big
-- embedding rows leave no room for HOT updates).
--
-- So membership is precomputed into a small SIDE table, keeping the embedding table
-- (and its HNSW index) immutable after ingest. The searches filter via a cheap
-- tile_id semi-join. Membership is maintained mechanically inside Postgres:
--   * v2_aois insert/update/delete  -> trigger recomputes the affected dataset
--   * tile generation swap          -> activate_tile_embeddings recomputes
-- "The AOI" for a dataset is the single latest-by-created_at row, matching the
-- frontend/export current-AOI rule (useDatasetAOI: order by created_at desc limit 1).

create table if not exists public.v2_tile_aoi_membership (
  tile_id bigint primary key
    references public.v2_tile_embeddings (id) on delete cascade,
  dataset_id bigint not null,
  in_aoi boolean not null
);

-- Recompute rescans by dataset; the semi-join probes by tile_id (the PK).
create index if not exists v2_tile_aoi_membership_dataset_id_idx
  on public.v2_tile_aoi_membership (dataset_id);

alter table public.v2_tile_aoi_membership enable row level security;
-- No policies: only the SECURITY DEFINER functions below touch this table, and they
-- run as the owner (bypassing RLS). Direct access from API roles is intentionally
-- denied — membership is an internal search-acceleration detail.

-- Recompute in_aoi for every tile of one dataset against its current (latest) AOI.
-- delete+insert (not diff-update) is fine: this is a tiny, un-indexed-vector table,
-- so rewriting a few hundred rows costs single-digit ms and never touches HNSW.
create or replace function public.recompute_tile_aoi_membership(p_dataset_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  aoi_geom geometry;
begin
  -- Serialize concurrent recomputes of the same dataset (e.g. an AOI save racing a
  -- processor activation, or two auditors saving at once). Without this, both run
  -- the delete+insert below and the second can collide on the membership PK under
  -- READ COMMITTED. Transaction-scoped; auto-released at commit/rollback. Different
  -- datasets take different keys, so cross-dataset recomputes never contend.
  perform pg_advisory_xact_lock(hashtext('recompute_tile_aoi_membership'), p_dataset_id::int);

  delete from public.v2_tile_aoi_membership where dataset_id = p_dataset_id;

  -- Nothing to do for the ~98% of AOI edits on datasets without embeddings.
  if not exists (
    select 1 from public.v2_tile_embeddings e where e.dataset_id = p_dataset_id
  ) then
    return;
  end if;

  -- The dataset's current AOI: latest by created_at, matching useDatasetAOI. No
  -- is_whole_image special casing — the polygon itself defines the region.
  select st_setsrid(st_geomfromgeojson(a.geometry::text), 4326)
    into aoi_geom
  from public.v2_aois a
  where a.dataset_id = p_dataset_id
  order by a.created_at desc
  limit 1;

  if aoi_geom is null then
    -- No AOI: nothing to restrict to, so every tile stays searchable.
    insert into public.v2_tile_aoi_membership (tile_id, dataset_id, in_aoi)
    select e.id, p_dataset_id, true
    from public.v2_tile_embeddings e
    where e.dataset_id = p_dataset_id;
    return;
  end if;

  -- Subdivide the AOI once (<=64-vtx pieces) so each tile's ST_Intersects is small
  -- and bbox-prunable even for many-thousand-vertex model AOIs. ST_MakeValid guards
  -- against self-intersecting model polygons that ST_Subdivide would reject.
  insert into public.v2_tile_aoi_membership (tile_id, dataset_id, in_aoi)
  select e.id, p_dataset_id,
         exists (
           select 1 from unnest(pieces.arr) as piece
           where st_intersects(e.geometry, piece)
         )
  from public.v2_tile_embeddings e
  cross join (
    select array_agg(p) as arr
    from st_subdivide(st_makevalid(aoi_geom), 64) as p
  ) pieces
  where e.dataset_id = p_dataset_id;
end;
$$;

-- AOI side: any change to a dataset's AOIs can change which row is "latest" or its
-- geometry, so refresh on every insert/update/delete. Editing a non-latest AOI just
-- recomputes to the same values (0 changed rows) — harmless and cheap.
create or replace function public.v2_aois_refresh_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.recompute_tile_aoi_membership(coalesce(new.dataset_id, old.dataset_id));
  -- An UPDATE that moved the AOI to another dataset must refresh both.
  if tg_op = 'UPDATE' and new.dataset_id is distinct from old.dataset_id then
    perform public.recompute_tile_aoi_membership(old.dataset_id);
  end if;
  return null;
end;
$$;

drop trigger if exists v2_aois_refresh_membership_trg on public.v2_aois;
create trigger v2_aois_refresh_membership_trg
  after insert or update or delete on public.v2_aois
  for each row execute function public.v2_aois_refresh_membership();

-- Tile side: recompute after the generation swap, when the new tiles become the
-- active, searchable set (and the old generation has been deleted).
create or replace function public.activate_tile_embeddings(
  p_dataset_id bigint,
  p_old_max_id bigint default null,
  p_expected_count integer default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  activated integer;
begin
  if (auth.jwt() ->> 'email'::text) is distinct from 'processor@deadtrees.earth'::text then
    raise exception 'not authorized to activate tile embeddings';
  end if;

  update public.v2_tile_embeddings
  set is_active = true
  where dataset_id = p_dataset_id
    and is_active = false
    and (p_old_max_id is null or id > p_old_max_id);

  get diagnostics activated = row_count;

  if p_expected_count is not null and activated <> p_expected_count then
    raise exception 'activated % tile embeddings, expected %', activated, p_expected_count;
  end if;

  if p_old_max_id is not null then
    delete from public.v2_tile_embeddings
    where dataset_id = p_dataset_id
      and id <= p_old_max_id;
  end if;

  -- Refresh AOI membership for the freshly-published generation.
  perform public.recompute_tile_aoi_membership(p_dataset_id);

  return activated;
end;
$$;

-- Rank datasets by their best-matching *in-AOI* tile.
-- Adds an in_aoi semi-join to the candidate pull. Because the filter can thin the
-- HNSW neighbour pool, enable iterative index scans so pgvector keeps descending the
-- graph until the pool is filled (relaxed order is fine — stage 2 re-ranks by the
-- calibrated probability anyway).
create or replace function public.search_datasets_by_embedding(
  query_embedding text,
  match_count integer default 50,
  min_similarity double precision default 0.0,
  temperature double precision default 50.0,
  candidate_pool integer default 500
)
returns table (
  dataset_id bigint,
  similarity double precision,
  tile_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  pool integer := least(greatest(candidate_pool, match_count), 1000);
begin
  perform set_config('hnsw.ef_search', pool::text, true);
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);

  return query
  with candidates as (
    select e.dataset_id, e.embedding, e.bg_sims
    from public.v2_tile_embeddings e
    where e.is_active
      and public.is_dataset_search_ready(e.dataset_id)
      and public.is_dataset_search_visible(e.dataset_id)
      and exists (
        select 1 from public.v2_tile_aoi_membership m
        where m.tile_id = e.id and m.in_aoi
      )
    order by e.embedding <=> query_embedding::vector(1024)
    limit pool
  )
  select
    c.dataset_id,
    max(public.tile_match_probability(1 - (c.embedding <=> query_embedding::vector(1024)), c.bg_sims, temperature))::double precision as similarity,
    count(*)::bigint as tile_count
  from candidates c
  group by c.dataset_id
  having max(public.tile_match_probability(1 - (c.embedding <=> query_embedding::vector(1024)), c.bg_sims, temperature)) >= min_similarity
  order by similarity desc
  limit greatest(match_count, 1);
end;
$$;

-- Rank one dataset's *in-AOI* tiles for map highlighting.
create or replace function public.search_tiles_by_embedding(
  query_embedding text,
  p_dataset_id bigint,
  match_count integer default 200,
  temperature double precision default 50.0
)
returns table (
  id bigint,
  similarity double precision,
  nodata_fraction real,
  geometry json
)
language sql
stable
security definer
set search_path = public
as $$
  with q as (select query_embedding::vector(1024) as v)
  select
    e.id,
    public.tile_match_probability(1 - (e.embedding <=> q.v), e.bg_sims, temperature)::double precision as similarity,
    e.nodata_fraction,
    st_asgeojson(e.geometry)::json as geometry
  from public.v2_tile_embeddings e
  cross join q
  where e.dataset_id = p_dataset_id
    and e.is_active
    and public.is_dataset_search_ready(e.dataset_id)
    and public.is_dataset_search_visible(e.dataset_id)
    and exists (
      select 1 from public.v2_tile_aoi_membership m
      where m.tile_id = e.id and m.in_aoi
    )
  order by similarity desc
  limit greatest(match_count, 1);
$$;

-- SECURITY DEFINER helper: keep it off the public API surface. It is only invoked
-- internally — the v2_aois trigger and activate_tile_embeddings, both SECURITY
-- DEFINER, so PostgreSQL checks EXECUTE against the owner, not the caller, and those
-- keep working. Revoke the implicit PUBLIC grant so anon/authenticated clients can't
-- call it directly to force recomputes for arbitrary datasets.
revoke all on function public.recompute_tile_aoi_membership(bigint) from public;
grant execute on function public.recompute_tile_aoi_membership(bigint) to service_role;

-- Backfill membership for every dataset that already has embeddings.
do $$
declare
  d bigint;
begin
  for d in select distinct dataset_id from public.v2_tile_embeddings loop
    perform public.recompute_tile_aoi_membership(d);
  end loop;
end;
$$;
