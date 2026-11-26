-- Prediction quality reads the predicted cover in batches of boxes (DT-1619).
--
-- Every call of the worker must end within its login's statement timeout: 8 s for the
-- authenticated role through PostgREST in production, and a function's own
-- statement_timeout setting changes nothing there. Working out the cover of the sample
-- inside audit.prediction_quality_candidates did not fit: on dataset 669 already 200
-- candidates timed out, and the polygons of 20 forest boxes did too (its forest label holds
-- 3,556 polygons over 64 KB, up to 3.8 MB each). So the candidates come without cover, and
-- the cover is read per prediction for a batch of boxes (audit.prediction_quality_cover),
-- as the polygons are; the worker sizes the batches so each call fits the timeout
-- (processor/src/prediction_quality_v1/handler.py, read_boxes).

-- p_boxes ([[xmin, ymin, xmax, ymax], ...] in EPSG:4326) as boxes, in order.
create function internal.prediction_boxes(p_boxes jsonb)
returns public.geometry[]
language sql immutable set search_path = ''
as $$
	select coalesce(
		array_agg(
			public.st_makeenvelope(
				(e.b ->> 0)::double precision, (e.b ->> 1)::double precision,
				(e.b ->> 2)::double precision, (e.b ->> 3)::double precision, 4326
			)
			order by e.i
		),
		'{}'
	)
	from jsonb_array_elements(coalesce(p_boxes, '[]'::jsonb)) with ordinality as e (b, i);
$$;

revoke all on function internal.prediction_boxes(jsonb) from public, anon, authenticated;

-- The tiles the check picks its sets from. A tile is inside the AOI when p_inside of its
-- footprint is (an AOI that holds no such tile: every tile it touches); p_aoi null (GeoJSON,
-- EPSG:4326) is the whole dataset. Of these, p_limit tiles in a fixed order (a hash of the
-- dataset and the tile's pixel window), so a rerun on the same data draws the same tiles.
--   {tiles: the dataset's tiles, tiles_inside: how many lie inside the AOI,
--    candidates: [{id, pixel_window [x0, y0, x1, y1], geometry (GeoJSON), aoi}]}
-- A dataset whose embedding stage has not finished has no tiles yet: the rows of a run in
-- progress are not all there.
drop function audit.prediction_quality_candidates(bigint, bigint, bigint, jsonb, integer, double precision);

create function audit.prediction_quality_candidates(
	p_dataset_id bigint,
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
	)
	select jsonb_build_object(
		'tiles', (select count(*) from tiles),
		'tiles_inside', (select count(*) from inside),
		'candidates', coalesce(
			(
				select jsonb_agg(
					jsonb_build_object(
						'id', d.id,
						'pixel_window', jsonb_build_array(d.pixel_x0, d.pixel_y0, d.pixel_x1, d.pixel_y1),
						'geometry', public.st_asgeojson(d.geometry)::jsonb,
						'aoi', d.aoi_share
					)
					order by d.n
				)
				from drawn d
			),
			'[]'::jsonb
		)
	)
	into v_result;
	return v_result;
end;
$$;

revoke all on function audit.prediction_quality_candidates(bigint, jsonb, integer, double precision) from public, anon;
grant execute on function audit.prediction_quality_candidates(bigint, jsonb, integer, double precision)
	to authenticated, service_role, analyst;

-- One prediction's share of each box (p_boxes as for internal.prediction_boxes): per box, in
-- order, the area of the prediction's polygons in it over the box's area. A prediction's
-- polygons do not overlap, so the share is clamped to 1 only against bad data.
create function audit.prediction_quality_cover(p_label_id bigint, p_boxes jsonb)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
	v_boxes public.geometry[];
	v_result jsonb;
begin
	if not internal.reads_prediction_quality_inputs() then
		raise exception 'Only the audit worker reads prediction quality inputs' using errcode = '42501';
	end if;
	v_boxes := internal.prediction_boxes(p_boxes);
	with covered as materialized (
		select p.box_index, sum(public.st_area(p.piece)) as area
		from internal.prediction_pieces(p_label_id, v_boxes) p
		group by p.box_index
	)
	select coalesce(jsonb_agg(least(1, coalesce(c.area, 0) / public.st_area(b.box)) order by b.i), '[]'::jsonb)
	into v_result
	from unnest(v_boxes) with ordinality as b (box, i)
	left join covered c on c.box_index = b.i;
	return v_result;
end;
$$;

revoke all on function audit.prediction_quality_cover(bigint, jsonb) from public, anon;
grant execute on function audit.prediction_quality_cover(bigint, jsonb) to authenticated, service_role, analyst;

-- The polygons read the boxes the same way (unchanged otherwise).
create or replace function audit.prediction_quality_polygons(p_label_id bigint, p_boxes jsonb)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
	v_boxes public.geometry[];
	v_result jsonb;
begin
	if not internal.reads_prediction_quality_inputs() then
		raise exception 'Only the audit worker reads prediction quality inputs' using errcode = '42501';
	end if;
	v_boxes := internal.prediction_boxes(p_boxes);
	with pieces as materialized (
		select p.box_index, jsonb_agg(public.st_asgeojson(p.piece)::jsonb) as list
		from internal.prediction_pieces(p_label_id, v_boxes) p
		group by p.box_index
	)
	select coalesce(jsonb_agg(coalesce(p.list, '[]'::jsonb) order by b.i), '[]'::jsonb)
	into v_result
	from unnest(v_boxes) with ordinality as b (box, i)
	left join pieces p on p.box_index = b.i;
	return v_result;
end;
$$;

notify pgrst, 'reload schema';
