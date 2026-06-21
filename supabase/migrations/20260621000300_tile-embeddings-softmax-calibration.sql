-- Calibrate tile-search scores into interpretable probabilities.
--
-- Raw CLIP image<->text cosine sits in a narrow uncalibrated band (~0.15-0.32),
-- so showing it as a "% match" is misleading. Instead we return a softmax of the
-- query against a fixed bank of generic "background" prompts:
--   P = softmax(temperature * [sim_query, sim_bg_1, ...])[query]
-- Each tile stores its (query-independent) cosine similarities to those prompts
-- in bg_sims, so the ranking functions only need the query vector. Falls back to
-- raw cosine for tiles with no bg_sims (backward compatible).

alter table public.v2_tile_embeddings
  add column if not exists bg_sims real[] not null default '{}';

-- Numerically-stable softmax of the query vs the stored background sims.
create or replace function public.tile_match_probability(
  sim_q double precision,
  bg_sims real[],
  temperature double precision
)
returns double precision
language sql
immutable
parallel safe
as $$
  select case
    when bg_sims is null or array_length(bg_sims, 1) is null then sim_q
    else (
      with logits as (
        select temperature * sim_q as ql,
               (select array_agg(temperature * b) from unnest(bg_sims) as b) as bl
      ),
      mx as (
        select ql, bl, greatest(ql, (select max(x) from unnest(bl) as x)) as m
        from logits
      )
      select exp(ql - m) / (exp(ql - m) + (select sum(exp(x - m)) from unnest(bl) as x))
      from mx
    )
  end;
$$;

-- Replace the ranking functions (new signatures add a `temperature` default, so
-- drop the old overloads first to avoid ambiguous resolution).
drop function if exists public.search_datasets_by_embedding(text, integer, double precision);
drop function if exists public.search_tiles_by_embedding(text, bigint, integer);
drop function if exists public.insert_tile_embeddings(bigint, jsonb);

-- Rank datasets by their best-matching tile's calibrated probability.
create or replace function public.search_datasets_by_embedding(
  query_embedding text,
  match_count integer default 50,
  min_similarity double precision default 0.0,
  temperature double precision default 50.0
)
returns table (
  dataset_id bigint,
  similarity double precision,
  tile_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with q as (select query_embedding::vector(1024) as v)
  select
    e.dataset_id,
    max(public.tile_match_probability(1 - (e.embedding <=> q.v), e.bg_sims, temperature))::double precision as similarity,
    count(*)::bigint as tile_count
  from public.v2_tile_embeddings e
  cross join q
  where public.is_dataset_search_visible(e.dataset_id)
  group by e.dataset_id
  having max(public.tile_match_probability(1 - (e.embedding <=> q.v), e.bg_sims, temperature)) >= min_similarity
  order by similarity desc
  limit greatest(match_count, 1);
$$;

-- Rank a dataset's tiles by calibrated probability (for map highlighting).
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
    and public.is_dataset_search_visible(e.dataset_id)
  order by similarity desc
  limit greatest(match_count, 1);
$$;

-- Insert tile embeddings (now also stores bg_sims).
create or replace function public.insert_tile_embeddings(
  p_dataset_id bigint,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  inserted integer;
begin
  if (auth.jwt() ->> 'email'::text) is distinct from 'processor@deadtrees.earth'::text then
    raise exception 'not authorized to write tile embeddings';
  end if;

  insert into public.v2_tile_embeddings
    (dataset_id, geometry, embedding, pixel_x0, pixel_y0, pixel_x1, pixel_y1, nodata_fraction, bg_sims)
  select
    p_dataset_id,
    st_makeenvelope(r.min_lon, r.min_lat, r.max_lon, r.max_lat, 4326),
    r.embedding::vector(1024),
    r.pixel_x0, r.pixel_y0, r.pixel_x1, r.pixel_y1, r.nodata_fraction,
    coalesce((select array_agg(x::real) from jsonb_array_elements_text(r.bg_sims) as x), '{}')
  from jsonb_to_recordset(p_rows) as r(
    min_lon double precision,
    min_lat double precision,
    max_lon double precision,
    max_lat double precision,
    embedding text,
    pixel_x0 integer,
    pixel_y0 integer,
    pixel_x1 integer,
    pixel_y1 integer,
    nodata_fraction real,
    bg_sims jsonb
  );

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

grant execute on function public.tile_match_probability(double precision, real[], double precision) to anon, authenticated, service_role;
grant execute on function public.search_datasets_by_embedding(text, integer, double precision, double precision) to anon, authenticated, service_role;
grant execute on function public.search_tiles_by_embedding(text, bigint, integer, double precision) to anon, authenticated, service_role;
grant execute on function public.insert_tile_embeddings(bigint, jsonb) to authenticated, service_role;
