-- Make the AI search ranking cheap for callers who cannot see every dataset.
--
-- The ranking RPCs filtered each scanned tile through is_dataset_search_ready()
-- and is_dataset_search_visible(). Those are SECURITY DEFINER SQL functions that
-- re-read the JWT and call further functions, which costs ~0.1-0.5 ms per tile.
-- Auditors rarely noticed: almost every tile is visible to them, so the HNSW scan
-- stops after ~candidate_pool tiles. For public callers a query whose nearest
-- neighbours sit in datasets they cannot see (one private dataset holds ~10% of
-- all tiles) keeps scanning up to hnsw.max_scan_tuples (20000), i.e. seconds of
-- pure filter overhead and statement timeouts.
--
-- Resolve the caller's searchable datasets once per query instead, and filter
-- tiles with a hashed array lookup.
BEGIN;

-- Set-based equivalent of
--   is_dataset_search_ready(id) AND is_dataset_search_visible(id)
-- for the current caller. Keep the predicate in sync with those functions
-- (20260625090200) and internal.is_dataset_excluded_from_public_surface
-- (20260615120000); api/tests/db/test_embedding_replacement.py checks both
-- ranking RPCs against the same visibility transitions.
create function internal.search_visible_dataset_ids()
returns bigint[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  sees_all boolean := public.can_view_all_private_data()
    or coalesce((auth.jwt() ->> 'email') = 'processor@deadtrees.earth', false);
begin
  return coalesce((
    select array_agg(d.id)
    from public.v2_datasets d
    where exists (
        select 1 from public.v2_statuses s
        where s.dataset_id = d.id and s.is_embeddings_done
      )
      and (d.data_access <> 'private'::access or d.user_id = uid or sees_all)
      and (d.archived = false or d.user_id = uid)
      and (
        d.user_id = uid
        or sees_all
        or not exists (
          select 1 from public.dataset_audit a
          where a.dataset_id = d.id and a.final_assessment = 'exclude_completely'
        )
      )
  ), '{}');
end;
$$;
revoke all on function internal.search_visible_dataset_ids() from public, anon, authenticated, service_role;

-- plan_cache_mode: a custom plan sees the dataset array as a constant, which is
-- what lets PostgreSQL hash the `= any(...)` lookup instead of scanning the array
-- for every tile.
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
set statement_timeout = '8s'
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  pool integer := least(greatest(candidate_pool, match_count), 1000);
  visible bigint[] := internal.search_visible_dataset_ids();
begin
  perform set_config('hnsw.ef_search', pool::text, true);
  perform set_config('hnsw.iterative_scan', 'relaxed_order', true);

  return query
  with candidates as (
    select e.dataset_id, e.embedding, e.bg_sims
    from public.v2_tile_embeddings e
    where e.dataset_id = any(visible)
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

-- One dataset: decide visibility once instead of once per tile.
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
language plpgsql
stable
security definer
set search_path = public
set statement_timeout = '8s'
as $$
begin
  if not (public.is_dataset_search_ready(p_dataset_id)
          and public.is_dataset_search_visible(p_dataset_id)) then
    return;
  end if;

  return query
  with q as (select query_embedding::vector(1024) as v)
  select
    e.id,
    public.tile_match_probability(1 - (e.embedding <=> q.v), e.bg_sims, temperature)::double precision as similarity,
    e.nodata_fraction,
    st_asgeojson(e.geometry)::json as geometry
  from public.v2_tile_embeddings e
  cross join q
  where e.dataset_id = p_dataset_id
    and exists (
      select 1 from public.v2_tile_aoi_membership m
      where m.tile_id = e.id and m.in_aoi
    )
  order by similarity desc
  -- Public callers choose match_count; bound the response size.
  limit least(greatest(match_count, 1), 1000);
end;
$$;

-- CREATE OR REPLACE keeps the existing grants (anon, authenticated).
NOTIFY pgrst, 'reload schema';
COMMIT;
