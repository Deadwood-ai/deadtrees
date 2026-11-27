-- The prediction quality check reads windows of a dataset, not the whole dataset (DT-1619).
--
-- The check judges 20 to 50 tiles, but it read every CLIP tile and every polygon of both
-- predictions to pick them: on dataset 669 (138,019 tiles, about 835k polygons) the audit
-- worker worked for hours without a word. Two reads keep its work to the tiles it judges:
--   audit.prediction_quality_candidates  a fixed sample of the dataset's tiles inside the AOI,
--                                         each with its predicted deadwood, forest and AOI share
--   audit.prediction_quality_polygons    one prediction's polygons cut to given boxes, read
--                                         only for the tiles picked from the sample
-- Both return one jsonb value, so PostgREST's max_rows never cuts them short.
--
-- The polygon filter (label_id, not is_deleted, geometry && box) needs no new index: per box
-- the GiST index on geometry (idx_deadwood_geom, idx_forest_cover_geom, as the label vector
-- tiles use it) finds the few polygons there, and the label is filtered on those. On a
-- synthetic dataset (30k tiles, 900k deadwood polygons of six labels, a forest polygon of
-- 511k vertices and 22k holes) 2000 candidates took 2.5 s and the polygons of 50 tiles 0.5 s.
-- Each call must end within the statement timeout of the worker's login (8 s for
-- authenticated in production); a function's own statement_timeout setting changes nothing.

-- The audit worker reads for its runs; an analyst login (not a superuser, who is a member of
-- every role) for the check's benchmark runs (scripts/qa/prediction-quality/run_check.py),
-- and may read these tables anyway.
create function internal.reads_prediction_quality_inputs()
returns boolean
language sql stable set search_path = ''
as $$
	select coalesce(
		internal.is_audit_worker()
			or current_setting('role', true) = 'service_role'
			or (select auth.jwt() ->> 'role') = 'service_role'
			or (
				pg_catalog.pg_has_role(session_user, 'analyst', 'usage')
				and not (select r.rolsuper from pg_catalog.pg_roles r where r.rolname = session_user)
			),
		false
	);
$$;

revoke all on function internal.reads_prediction_quality_inputs() from public, anon;
grant execute on function internal.reads_prediction_quality_inputs() to authenticated, service_role;

-- One prediction's polygons cut to each box, as (position of the box in p_boxes, piece). A
-- label's polygons live in the table of its layer. A polygon is cut by each box it overlaps,
-- with the tolerant box clip; a big one (a forest cover polygon can span the ortho with
-- millions of vertices) is first intersected once with all its boxes, so it is read and cut
-- once instead of once per box. That intersection needs a valid polygon, as the processor
-- writes them; on an invalid one it fails instead of measuring garbage. Each cut piece is
-- made valid (a self-intersecting polygon would otherwise measure no area).
create function internal.prediction_pieces(p_label_id bigint, p_boxes public.geometry[])
returns table (box_index bigint, piece public.geometry)
language sql stable set search_path = ''
as $$
	with boxes as (
		select b.box, b.i from unnest(p_boxes) with ordinality as b (box, i)
	),
	layer as (
		select l.label_data::text as name from public.v2_labels l where l.id = p_label_id
	),
	hits as (
		-- pg_column_size reads the stored size without fetching the geometry
		select b.i, g.id, g.geometry, pg_catalog.pg_column_size(g.geometry) > 65536 as big
		from boxes b
		join public.v2_deadwood_geometries g on g.geometry operator(public.&&) b.box
		where (select name from layer) = 'deadwood' and g.label_id = p_label_id and not g.is_deleted
		union all
		select b.i, g.id, g.geometry, pg_catalog.pg_column_size(g.geometry) > 65536
		from boxes b
		join public.v2_forest_cover_geometries g on g.geometry operator(public.&&) b.box
		where (select name from layer) = 'forest_cover' and g.label_id = p_label_id and not g.is_deleted
	),
	-- materialized: inlined into the join below, the intersection would run once per row
	big as materialized (
		select d.id, p.geom as part
		from (select distinct on (h.id) h.id, h.geometry from hits h where h.big order by h.id) d
		join (
			select h.id, public.st_union(b.box) as area from hits h join boxes b on b.i = h.i where h.big group by h.id
		) u on u.id = d.id
		cross join lateral public.st_dump(public.st_intersection(d.geometry, u.area)) p
	),
	parts as (
		select h.i, h.geometry as part from hits h where not h.big
		union all
		select h.i, g.part
		from hits h
		join big g on g.id = h.id
		join boxes b on b.i = h.i
		where g.part operator(public.&&) b.box
	),
	cut as (
		select p.i, public.st_collectionextract(
			public.st_makevalid(public.st_clipbybox2d(p.part, public.box2d(b.box))), 3
		) as piece
		from parts p
		join boxes b on b.i = p.i
	)
	select c.i, c.piece from cut c where not public.st_isempty(c.piece);
$$;

revoke all on function internal.prediction_pieces(bigint, public.geometry[]) from public, anon, authenticated;

-- The tiles the check picks its sets from. A tile is inside the AOI when p_inside of its
-- footprint is (an AOI that holds no such tile: every tile it touches); p_aoi null (GeoJSON,
-- EPSG:4326) is the whole dataset. Of these, p_limit tiles in a fixed order (a hash of the
-- dataset and the tile's pixel window), so a rerun on the same data draws the same tiles.
-- Each drawn tile's share of predicted deadwood and forest is the area of the prediction in
-- its footprint (an envelope) over the footprint's area; a prediction's polygons do not
-- overlap, so the share is clamped to 1 only against bad data.
--   {tiles: the dataset's tiles, tiles_inside: how many lie inside the AOI,
--    candidates: [{id, pixel_window [x0, y0, x1, y1], geometry (GeoJSON), deadwood, forest, aoi}]}
-- A dataset whose embedding stage has not finished has no tiles yet: the rows of a run in
-- progress are not all there.
create function audit.prediction_quality_candidates(
	p_dataset_id bigint,
	p_deadwood_label_id bigint,
	p_forest_label_id bigint,
	p_aoi jsonb,
	p_limit integer,
	p_inside double precision
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
	v_aoi public.geometry;
	v_result jsonb;
begin
	if not internal.reads_prediction_quality_inputs() then
		raise exception 'Only the audit worker reads prediction quality inputs' using errcode = '42501';
	end if;
	if p_aoi is not null and p_aoi <> 'null'::jsonb then
		v_aoi := public.st_makevalid(public.st_setsrid(public.st_geomfromgeojson(p_aoi::text), 4326));
	end if;
	if not public.is_dataset_search_ready(p_dataset_id) then
		return jsonb_build_object('tiles', 0, 'tiles_inside', 0, 'candidates', '[]'::jsonb);
	end if;
	with tiles as (
		select e.id, e.pixel_x0, e.pixel_y0, e.pixel_x1, e.pixel_y1, e.geometry,
			case
				when v_aoi is null then 1.0
				when not public.st_intersects(e.geometry, v_aoi) then 0.0
				when public.st_coveredby(e.geometry, v_aoi) then 1.0
				else public.st_area(public.st_intersection(e.geometry, v_aoi)) / public.st_area(e.geometry)
			end as aoi_share
		from public.v2_tile_embeddings e
		where e.dataset_id = p_dataset_id
	),
	inside as (
		select * from tiles where aoi_share >= p_inside
		union all
		select * from tiles where aoi_share > 0 and not exists (select 1 from tiles where aoi_share >= p_inside)
	),
	drawn as (
		select i.*, row_number() over (order by pg_catalog.md5(concat_ws(':', p_dataset_id, i.pixel_x0, i.pixel_y0))) as n
		from inside i
		order by n
		limit greatest(p_limit, 0)
	),
	boxes as (
		select coalesce(array_agg(d.geometry order by d.n), '{}') as list from drawn d
	),
	deadwood as materialized (
		select p.box_index, sum(public.st_area(p.piece)) as area
		from internal.prediction_pieces(p_deadwood_label_id, (select list from boxes)) p
		group by p.box_index
	),
	forest as materialized (
		select p.box_index, sum(public.st_area(p.piece)) as area
		from internal.prediction_pieces(p_forest_label_id, (select list from boxes)) p
		group by p.box_index
	)
	select jsonb_build_object(
		'tiles', (select count(*) from tiles),
		'tiles_inside', (select count(*) from inside),
		'candidates', coalesce(
			jsonb_agg(
				jsonb_build_object(
					'id', d.id,
					'pixel_window', jsonb_build_array(d.pixel_x0, d.pixel_y0, d.pixel_x1, d.pixel_y1),
					'geometry', public.st_asgeojson(d.geometry)::jsonb,
					'deadwood', least(1, coalesce(dw.area, 0) / public.st_area(d.geometry)),
					'forest', least(1, coalesce(fc.area, 0) / public.st_area(d.geometry)),
					'aoi', d.aoi_share
				)
				order by d.n
			),
			'[]'::jsonb
		)
	)
	into v_result
	from drawn d
	left join deadwood dw on dw.box_index = d.n
	left join forest fc on fc.box_index = d.n;
	return v_result;
end;
$$;

revoke all on function audit.prediction_quality_candidates(bigint, bigint, bigint, jsonb, integer, double precision)
	from public, anon;
grant execute on function audit.prediction_quality_candidates(bigint, bigint, bigint, jsonb, integer, double precision)
	to authenticated, service_role, analyst;

-- One prediction's polygons cut to each box (p_boxes: [[xmin, ymin, xmax, ymax], ...] in
-- EPSG:4326): per box, in order, a list of GeoJSON geometries. The check reads them for the
-- tiles it picked, to draw the overlays.
create function audit.prediction_quality_polygons(p_label_id bigint, p_boxes jsonb)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
	v_result jsonb;
begin
	if not internal.reads_prediction_quality_inputs() then
		raise exception 'Only the audit worker reads prediction quality inputs' using errcode = '42501';
	end if;
	with boxes as (
		select e.i, public.st_makeenvelope(
			(e.b ->> 0)::double precision, (e.b ->> 1)::double precision,
			(e.b ->> 2)::double precision, (e.b ->> 3)::double precision, 4326
		) as box
		from jsonb_array_elements(coalesce(p_boxes, '[]'::jsonb)) with ordinality as e (b, i)
	),
	pieces as materialized (
		select p.box_index, jsonb_agg(public.st_asgeojson(p.piece)::jsonb) as list
		from internal.prediction_pieces(p_label_id, (select coalesce(array_agg(b.box order by b.i), '{}') from boxes b)) p
		group by p.box_index
	)
	select coalesce(jsonb_agg(coalesce(p.list, '[]'::jsonb) order by b.i), '[]'::jsonb)
	into v_result
	from boxes b
	left join pieces p on p.box_index = b.i;
	return v_result;
end;
$$;

revoke all on function audit.prediction_quality_polygons(bigint, jsonb) from public, anon;
grant execute on function audit.prediction_quality_polygons(bigint, jsonb) to authenticated, service_role, analyst;

notify pgrst, 'reload schema';
