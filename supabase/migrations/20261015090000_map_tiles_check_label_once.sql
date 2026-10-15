-- Map tiles check the label's visibility once per tile, not once per polygon.
--
-- The geometry read policies ask whether each row's label is visible. Postgres
-- applies a row policy before any non-leakproof filter such as the tile bbox,
-- so a tile evaluated that rule for every polygon of the label and could not use
-- the spatial index. Anonymous tiles of a 5,000-polygon label took about 2.4 s,
-- and forest cover tiles hit the 3 s statement timeout.
--
-- The geometry of a tile depends only on its label, so each tile function now
-- asks the caller's own v2_labels rule once, then reads the tile through an
-- internal function that runs without row policies and can use the spatial
-- index. The internal schema is not exposed by the API. Tile contents and the
-- function signatures are unchanged; the geometry policies still govern direct
-- table reads.

begin;

-- Only function definitions change; no table is locked.
set local lock_timeout = '5s';

create or replace function internal.deadwood_tile_mvt(
	z integer, x integer, y integer, filter_label_id bigint, resolution integer, filter_correction_status text
)
returns bytea
language sql stable security definer set search_path = ''
as $$
	with
	bbox as (
		select public.st_tileenvelope(z, x, y) as bbox_3857
	),
	settings as (
		select
			case when z < 8 then 100000
				when z < 10 then 10000
				when z < 12 then 1000
				when z < 14 then 100
				else 0 end as min_area
	)
	select public.st_asmvt(tile_data, 'deadwood', resolution)
	from (
		select
			public.st_asmvtgeom(public.st_transform(g.geometry, 3857), b.bbox_3857, resolution, 256, true) as geom,
			g.id,
			g.label_id,
			g.properties,
			g.is_deleted,
			coalesce(c.review_status, 'original') as correction_status,
			c.operation as correction_operation,
			c.id as correction_id
		from public.v2_deadwood_geometries g
		cross join bbox b
		cross join settings s
		left join lateral (
			select id, review_status, operation
			from public.v2_geometry_corrections
			where geometry_id = g.id and layer_type = 'deadwood'
			order by created_at desc
			limit 1
		) c on true
		where
			g.label_id = filter_label_id
			and g.area_m2 >= s.min_area
			and g.geometry operator(public.&&) public.st_transform(b.bbox_3857, public.st_srid(g.geometry))
			and public.st_intersects(g.geometry, public.st_transform(b.bbox_3857, public.st_srid(g.geometry)))
			and (
				case filter_correction_status
					when 'all' then true
					when 'pending' then c.review_status = 'pending'
					else g.is_deleted = false
				end
			)
		limit 100000
	) as tile_data
	where tile_data.geom is not null;
$$;

create or replace function internal.forest_cover_tile_mvt(
	z integer, x integer, y integer, filter_label_id bigint, resolution integer, filter_correction_status text
)
returns bytea
language sql stable security definer set search_path = ''
as $$
	with
	bbox as (
		select public.st_tileenvelope(z, x, y) as bbox_3857
	),
	settings as (
		select
			case when z < 6 then 1000000
				when z < 8 then 500000
				when z < 10 then 100000
				when z < 12 then 50000
				when z < 14 then 10000
				else 0 end as min_area
	)
	select public.st_asmvt(tile_data, 'forest_cover', resolution)
	from (
		select
			public.st_asmvtgeom(public.st_transform(g.geometry, 3857), b.bbox_3857, resolution, 128, true) as geom,
			g.id,
			g.label_id,
			g.properties,
			g.is_deleted,
			coalesce(c.review_status, 'original') as correction_status,
			c.operation as correction_operation,
			c.id as correction_id
		from public.v2_forest_cover_geometries g
		cross join bbox b
		cross join settings s
		left join lateral (
			select id, review_status, operation
			from public.v2_geometry_corrections
			where geometry_id = g.id and layer_type = 'forest_cover'
			order by created_at desc
			limit 1
		) c on true
		where
			g.label_id = filter_label_id
			and g.area_m2 >= s.min_area
			and g.geometry operator(public.&&) public.st_transform(b.bbox_3857, public.st_srid(g.geometry))
			and public.st_intersects(g.geometry, public.st_transform(b.bbox_3857, public.st_srid(g.geometry)))
			and (
				case filter_correction_status
					when 'all' then true
					when 'pending' then c.review_status = 'pending'
					else g.is_deleted = false
				end
			)
		limit 50000
	) as tile_data
	where tile_data.geom is not null;
$$;

-- The tile functions below run as the caller and call these after the label check.
revoke all on function internal.deadwood_tile_mvt(integer, integer, integer, bigint, integer, text) from public, anon, authenticated;
revoke all on function internal.forest_cover_tile_mvt(integer, integer, integer, bigint, integer, text) from public, anon, authenticated;
grant execute on function internal.deadwood_tile_mvt(integer, integer, integer, bigint, integer, text) to anon, authenticated, service_role;
grant execute on function internal.forest_cover_tile_mvt(integer, integer, integer, bigint, integer, text) to anon, authenticated, service_role;

-- A label the caller cannot see yields the same empty tile as before.
create or replace function public.get_deadwood_tiles_with_corrections(
	z integer, x integer, y integer, filter_label_id bigint,
	resolution integer default 4096, filter_correction_status text default null
)
returns text
language sql stable
as $$
	select encode(
		case when exists (select 1 from public.v2_labels label where label.id = filter_label_id)
			then coalesce(internal.deadwood_tile_mvt(z, x, y, filter_label_id, resolution, filter_correction_status), ''::bytea)
			else ''::bytea
		end,
		'base64'
	);
$$;

create or replace function public.get_forest_cover_tiles_with_corrections(
	z integer, x integer, y integer, filter_label_id bigint,
	resolution integer default 4096, filter_correction_status text default null
)
returns text
language sql stable
as $$
	select encode(
		case when exists (select 1 from public.v2_labels label where label.id = filter_label_id)
			then coalesce(internal.forest_cover_tile_mvt(z, x, y, filter_label_id, resolution, filter_correction_status), ''::bytea)
			else ''::bytea
		end,
		'base64'
	);
$$;

commit;
