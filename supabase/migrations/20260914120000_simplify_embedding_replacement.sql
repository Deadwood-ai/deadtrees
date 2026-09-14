-- Internal AI search may disappear during replacement. The dataset completion
-- flag is the publication boundary; tile rows are immutable after insertion.
-- Deploy before the new processor. Legacy insert/activation RPCs are removed:
-- an old worker must fail closed instead of publishing an unvalidated result.
BEGIN;

-- Never turn historical failed/partial inactive rows into searchable results.
UPDATE public.v2_statuses s SET is_embeddings_done = false
WHERE s.is_embeddings_done
  AND EXISTS (SELECT 1 FROM public.v2_tile_embeddings e WHERE e.dataset_id=s.dataset_id AND NOT e.is_active)
  AND NOT EXISTS (SELECT 1 FROM public.v2_tile_embeddings e WHERE e.dataset_id=s.dataset_id AND e.is_active);
DELETE FROM public.v2_tile_embeddings WHERE NOT is_active;

DROP FUNCTION public.activate_tile_embeddings(bigint, bigint, integer);
DROP FUNCTION public.insert_tile_embeddings(bigint, jsonb);

DROP POLICY "Allow public read access to tile embeddings" ON public.v2_tile_embeddings;
CREATE POLICY "Allow public read access to tile embeddings"
ON public.v2_tile_embeddings FOR SELECT TO public
USING (public.is_dataset_search_ready(dataset_id) AND public.is_dataset_search_visible(dataset_id));

-- All processor writes go through claim-checked RPCs, including stale-row cleanup.
REVOKE INSERT, UPDATE, DELETE ON public.v2_tile_embeddings FROM authenticated, anon;
DROP POLICY "Allow processor to write tile embeddings" ON public.v2_tile_embeddings;
DROP POLICY "Allow processor to delete tile embeddings" ON public.v2_tile_embeddings;
ALTER TABLE public.v2_tile_embeddings DROP COLUMN is_active;

-- Authenticated users can insert status rows (which are not unique per dataset),
-- and auditors/processor can update statuses. Neither path may bypass the new
-- publication boundary. The completion RPC runs as its trusted database owner;
-- keep normal status changes and clearing completion available under existing RLS.
CREATE FUNCTION internal.guard_embedding_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') AND NEW.is_embeddings_done
     AND (TG_OP='INSERT' OR NEW.is_embeddings_done IS DISTINCT FROM OLD.is_embeddings_done) THEN
    RAISE EXCEPTION 'embedding completion requires the validated completion RPC' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION internal.guard_embedding_completion() FROM public, anon, authenticated, service_role;
CREATE TRIGGER guard_embedding_completion
BEFORE INSERT OR UPDATE OF is_embeddings_done ON public.v2_statuses
FOR EACH ROW EXECUTE FUNCTION internal.guard_embedding_completion();

-- Reuse the queue's existing claim as the attempt identity. Lock the claim and
-- status row for each RPC so insert/finish cannot race a reclaim or each other.
CREATE FUNCTION internal.lock_embedding_task(p_task_id bigint, p_claimed_at timestamptz)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  task public.v2_queue%ROWTYPE;
BEGIN
  IF (auth.jwt()->>'email') IS DISTINCT FROM 'processor@deadtrees.earth' THEN
    RAISE EXCEPTION 'not authorized to replace tile embeddings' USING ERRCODE='42501';
  END IF;
  SELECT * INTO task FROM public.v2_queue WHERE id=p_task_id FOR UPDATE;
  IF NOT FOUND OR task.is_processing IS NOT TRUE OR task.claimed_by IS NULL
     OR p_claimed_at IS NULL OR task.claimed_at IS DISTINCT FROM p_claimed_at
     OR NOT coalesce('embeddings_v1' = ANY(task.task_types), false) THEN
    RAISE EXCEPTION 'embedding task claim is no longer current' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM public.v2_statuses WHERE dataset_id=task.dataset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dataset status missing'; END IF;
  IF EXISTS (SELECT 1 FROM public.v2_queue q WHERE q.dataset_id=task.dataset_id
             AND q.is_processing AND q.id<>task.id) THEN
    RAISE EXCEPTION 'another task is processing this dataset' USING ERRCODE='55000';
  END IF;
  RETURN task.dataset_id;
END;
$$;
REVOKE ALL ON FUNCTION internal.lock_embedding_task(bigint,timestamptz) FROM public, anon, authenticated, service_role;

CREATE FUNCTION public.begin_tile_embeddings(p_task_id bigint, p_claimed_at timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '90s' AS $$
DECLARE d bigint;
BEGIN
  d := internal.lock_embedding_task(p_task_id,p_claimed_at);
  IF EXISTS (SELECT 1 FROM public.v2_statuses WHERE dataset_id=d AND current_status='embedding_processing') THEN
    RAISE EXCEPTION 'embedding replacement already started';
  END IF;
  UPDATE public.v2_statuses SET is_embeddings_done=false,
    current_status='embedding_processing', updated_at=now() WHERE dataset_id=d;
  -- Serialize with AOI edits before cascading membership deletions.
  PERFORM pg_advisory_xact_lock(hashtext('recompute_tile_aoi_membership'),d::int);
  DELETE FROM public.v2_tile_embeddings WHERE dataset_id=d;
END;
$$;

CREATE FUNCTION public.insert_tile_embeddings(
  p_task_id bigint, p_claimed_at timestamptz, p_offset integer, p_rows jsonb
)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '90s' AS $$
DECLARE d bigint; inserted integer;
BEGIN
  d := internal.lock_embedding_task(p_task_id,p_claimed_at);
  IF NOT EXISTS (SELECT 1 FROM public.v2_statuses WHERE dataset_id=d
                 AND current_status='embedding_processing' AND NOT is_embeddings_done AND NOT has_error) THEN
    RAISE EXCEPTION 'embedding replacement is not in progress';
  END IF;
  -- Reject replayed/out-of-order chunks instead of silently duplicating rows.
  IF p_offset IS NULL OR p_offset < 0 OR p_offset <> (SELECT count(*) FROM public.v2_tile_embeddings WHERE dataset_id=d) THEN
    RAISE EXCEPTION 'embedding chunk offset mismatch';
  END IF;
  -- Matches processor/src/process_embeddings.py's _INSERT_CHUNK_SIZE.
  IF p_rows IS NULL OR jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'embedding chunk must contain 1 to 200 rows';
  END IF;
  insert into public.v2_tile_embeddings
    (dataset_id, geometry, embedding, pixel_x0, pixel_y0, pixel_x1, pixel_y1, nodata_fraction, bg_sims)
  select
    d,
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

  GET DIAGNOSTICS inserted = ROW_COUNT;
  RETURN inserted;
END;
$$;

CREATE FUNCTION public.complete_tile_embeddings(p_task_id bigint, p_claimed_at timestamptz, p_expected_count integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '90s' AS $$
DECLARE d bigint; stored integer;
BEGIN
  d := internal.lock_embedding_task(p_task_id,p_claimed_at);
  IF NOT EXISTS (SELECT 1 FROM public.v2_statuses WHERE dataset_id=d
                 AND current_status='embedding_processing' AND NOT is_embeddings_done AND NOT has_error) THEN
    RAISE EXCEPTION 'embedding replacement is not in progress';
  END IF;
  SELECT count(*) INTO stored FROM public.v2_tile_embeddings WHERE dataset_id=d;
  IF p_expected_count IS NULL OR p_expected_count<0 OR stored<>p_expected_count THEN
    RAISE EXCEPTION 'stored % tile embeddings, expected %',stored,p_expected_count;
  END IF;
  PERFORM public.recompute_tile_aoi_membership(d);
  UPDATE public.v2_statuses SET is_embeddings_done=true,current_status='idle',updated_at=now()
  WHERE dataset_id=d;
  RETURN stored;
END;
$$;

REVOKE ALL ON FUNCTION public.begin_tile_embeddings(bigint,timestamptz) FROM public,anon,service_role;
REVOKE ALL ON FUNCTION public.insert_tile_embeddings(bigint,timestamptz,integer,jsonb) FROM public,anon,service_role;
REVOKE ALL ON FUNCTION public.complete_tile_embeddings(bigint,timestamptz,integer) FROM public,anon,service_role;
GRANT EXECUTE ON FUNCTION public.begin_tile_embeddings(bigint,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.insert_tile_embeddings(bigint,timestamptz,integer,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_tile_embeddings(bigint,timestamptz,integer) TO authenticated;

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

NOTIFY pgrst, 'reload schema';
COMMIT;
