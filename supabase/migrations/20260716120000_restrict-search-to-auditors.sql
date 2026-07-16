-- Temporarily restrict vector search ranking to auditors.
--
-- Keep the public embedding endpoint and direct Supabase RPC architecture so a
-- later anonymous rollout only needs a forward migration that removes these
-- capability checks and grants EXECUTE to anon. Dataset visibility remains
-- enforced inside the ranking functions.

-- can_audit() is the authorization boundary used by these SECURITY DEFINER
-- functions. Pin its search path and qualify dependencies so callers cannot
-- influence object resolution.
create or replace function public.can_audit()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.privileged_users
    where privileged_users.user_id = auth.uid()
      and privileged_users.can_audit = true
  );
$$;

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
  if not public.can_audit() then
    raise exception 'AI search is restricted to auditors'
      using errcode = '42501';
  end if;

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
as $$
begin
  if not public.can_audit() then
    raise exception 'AI search is restricted to auditors'
      using errcode = '42501';
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
    and e.is_active
    and public.is_dataset_search_ready(e.dataset_id)
    and public.is_dataset_search_visible(e.dataset_id)
    and exists (
      select 1 from public.v2_tile_aoi_membership m
      where m.tile_id = e.id and m.in_aoi
    )
  order by similarity desc
  limit greatest(match_count, 1);
end;
$$;

revoke execute on function public.search_datasets_by_embedding(text, integer, double precision, double precision, integer)
  from public, anon, service_role;
revoke execute on function public.search_tiles_by_embedding(text, bigint, integer, double precision)
  from public, anon, service_role;
grant execute on function public.search_datasets_by_embedding(text, integer, double precision, double precision, integer)
  to authenticated;
grant execute on function public.search_tiles_by_embedding(text, bigint, integer, double precision)
  to authenticated;
