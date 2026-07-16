-- Tighten AOI membership: a tile counts as in-AOI only if it is FULLY contained.
--
-- The original rule (20260710120000) marked a tile in_aoi when it merely intersected
-- the AOI, so tiles clipping the AOI edge — mostly background outside the labelled
-- region — stayed searchable. Switch to a containment test (ST_Covers): every point
-- of the tile must lie inside the AOI.
--
-- Containment must be evaluated against the WHOLE (validated) AOI polygon, not the
-- ST_Subdivide pieces the old intersects path used: a tile straddling a subdivision
-- boundary is covered by the union of pieces yet by no single piece, so a per-piece
-- ST_Covers would wrongly drop it. ST_Covers caches its prepared geometry across rows
-- when the AOI is a query constant, so a single whole-polygon pass stays single-digit
-- ms even for many-thousand-vertex model AOIs (naive whole-polygon predicate measured
-- ~1.6ms over 400 tiles vs a 7k-vertex AOI — comparable to the old subdivided path).
--
-- Only the recompute function changes; the trigger, activate hook and search RPCs are
-- unaffected. Re-backfill afterwards so existing membership reflects the tighter rule.
create or replace function public.recompute_tile_aoi_membership(p_dataset_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  aoi_geom geometry;
begin
  -- Serialize concurrent recomputes of the same dataset (see 20260710120000): both
  -- delete+insert below and can otherwise collide on the membership PK under READ
  -- COMMITTED. Transaction-scoped; different datasets take different keys.
  perform pg_advisory_xact_lock(hashtext('recompute_tile_aoi_membership'), p_dataset_id::int);

  delete from public.v2_tile_aoi_membership where dataset_id = p_dataset_id;

  -- Nothing to do for the ~98% of AOI edits on datasets without embeddings.
  if not exists (
    select 1 from public.v2_tile_embeddings e where e.dataset_id = p_dataset_id
  ) then
    return;
  end if;

  -- The dataset's current AOI: latest by created_at, matching useDatasetAOI. Validate
  -- once (self-intersecting model polygons would break ST_Covers) so the row-wise
  -- predicate below reuses one prepared geometry.
  select st_makevalid(st_setsrid(st_geomfromgeojson(a.geometry::text), 4326))
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

  -- Fully-contained only: ST_Covers(aoi, tile) is true iff no point of the tile lies
  -- outside the AOI. Tested against the whole polygon (not subdivided pieces) for the
  -- straddling-boundary reason noted in the header.
  insert into public.v2_tile_aoi_membership (tile_id, dataset_id, in_aoi)
  select e.id, p_dataset_id, st_covers(aoi_geom, e.geometry)
  from public.v2_tile_embeddings e
  where e.dataset_id = p_dataset_id;
end;
$$;

-- Re-backfill every dataset that has embeddings under the new containment rule.
do $$
declare
  d bigint;
begin
  for d in select distinct dataset_id from public.v2_tile_embeddings loop
    perform public.recompute_tile_aoi_membership(d);
  end loop;
end;
$$;
