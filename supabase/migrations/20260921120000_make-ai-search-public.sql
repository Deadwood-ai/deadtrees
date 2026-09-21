-- Open AI (open-vocabulary) search to everyone, including anonymous visitors.
--
-- This is the forward migration anticipated by
-- 20260716120000_restrict-search-to-auditors.sql: drop the can_audit() checks
-- from the ranking RPCs and grant EXECUTE to anon. Dataset visibility is still
-- enforced per caller by is_dataset_search_visible(), and anon can already read
-- the same tile rows through RLS, so no new data becomes reachable.
--
-- v2_search_queries stays auditor-only: anonymous/public query text must not be
-- logged there (see 20260711130000_add-search-query-log.sql).
BEGIN;

-- anon's role default is statement_timeout=3s and the archive ranking has been
-- observed at ~2.7s. PostgREST hoists function-level settings, so pin the same
-- budget authenticated callers already get.
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
    where public.is_dataset_search_ready(e.dataset_id)
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
    and public.is_dataset_search_ready(e.dataset_id)
    and public.is_dataset_search_visible(e.dataset_id)
    and exists (
      select 1 from public.v2_tile_aoi_membership m
      where m.tile_id = e.id and m.in_aoi
    )
  order by similarity desc
  -- Public callers choose match_count; bound the response size.
  limit least(greatest(match_count, 1), 1000);
end;
$$;

revoke execute on function public.search_datasets_by_embedding(text, integer, double precision, double precision, integer)
  from public, service_role;
revoke execute on function public.search_tiles_by_embedding(text, bigint, integer, double precision)
  from public, service_role;
grant execute on function public.search_datasets_by_embedding(text, integer, double precision, double precision, integer)
  to anon, authenticated;
grant execute on function public.search_tiles_by_embedding(text, bigint, integer, double precision)
  to anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
