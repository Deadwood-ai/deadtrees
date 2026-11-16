-- Ground resolution of the uploaded orthophoto, for the dataset details page and
-- the archive resolution filter.
--
-- 20261116180000 measured the COG, which is reprojected to web mercator and
-- snapped to a map zoom level, so it is often 5-50% off the orthophoto. The
-- orthophoto's own pixel size is converted from its CRS units to ground metres:
-- degrees and web mercator by latitude, projected CRSs by their linear unit.
-- CRSs given as WKT instead of an EPSG code use the last unit after PROJECTION
-- (the projected unit), or the LOCAL_CS unit. The COG value remains the fallback
-- for orthophotos without a usable CRS.

begin;

-- One dataset, or every dataset when p_dataset_id is null. Reads v2_cogs, which
-- only bulk COG readers may read, so it is executable by the owner alone and
-- exposed through the two functions below.
create function internal.ground_resolution(p_dataset_id bigint default null)
returns table (dataset_id bigint, gsd_cm real)
language sql
stable
security definer
set search_path = ''
as $$
	with ortho as (
		select
			o.dataset_id,
			o.ortho_info -> 'GEO' ->> 'CRS' as crs,
			abs((o.ortho_info -> 'GEO' -> 'Resolution' ->> 0)::double precision) as pixel_size,
			cos(radians((public.st_ymin(o.bbox::public.box3d) + public.st_ymax(o.bbox::public.box3d)) / 2)) as cos_lat
		from public.v2_orthos o
		where p_dataset_id is null or o.dataset_id = p_dataset_id
	), native as (
		select
			ortho.dataset_id,
			ortho.cos_lat,
			ortho.pixel_size * case
				when srs.proj4text like '%+proj=longlat%' then 111320 * ortho.cos_lat
				when srs.proj4text like '%+proj=merc%' then ortho.cos_lat
				when srs.srid is not null then
					case coalesce(substring(srs.proj4text from '\+units=(\S+)'), 'm')
						when 'm' then 1
						when 'us-ft' then 0.3048006096
						when 'ft' then 0.3048
					end
				when ortho.crs like 'LOCAL\_CS[%' then
					substring(ortho.crs from 'UNIT\["[^"]*",([0-9.]+)')::double precision
				when ortho.crs like '%PROJECTION["Mercator%' or ortho.crs like '%PROJECTION["Popular_Visualisation%' then
					ortho.cos_lat * substring(ortho.crs from 'PROJECTION\[.*UNIT\["[^"]*",([0-9.]+)')::double precision
				else substring(ortho.crs from 'PROJECTION\[.*UNIT\["[^"]*",([0-9.]+)')::double precision
			end as metres
		from ortho
		left join public.spatial_ref_sys srs
			on ortho.crs ~ '^EPSG:[0-9]+$'
			and srs.srid = case when ortho.crs ~ '^EPSG:[0-9]+$' then split_part(ortho.crs, ':', 2)::integer end
	)
	select
		native.dataset_id,
		round(
			coalesce(
				native.metres,
				-- COG fallback: always web mercator.
				case when cog.cog_info -> 'GEO' ->> 'CRS' = 'EPSG:3857' then
					abs((cog.cog_info -> 'GEO' -> 'Resolution' ->> 0)::double precision) * native.cos_lat
				end
			)::numeric * 100,
			1
		)::real
	from native
	left join public.v2_cogs cog on cog.dataset_id = native.dataset_id;
$$;
revoke all on function internal.ground_resolution(bigint) from public, anon, authenticated;

-- The archive view keeps calling this helper; it now returns the orthophoto value.
create or replace function internal.archive_ground_resolution()
returns table (dataset_id bigint, gsd_cm real)
language sql
stable
security definer
set search_path = ''
as $$
	select resolution.dataset_id, resolution.gsd_cm
	from internal.ground_resolution() resolution
	where resolution.gsd_cm is not null;
$$;

-- One dataset's resolution, for its details page: null unless the caller may
-- see the dataset.
create function public.dataset_ground_resolution(p_dataset_id bigint)
returns real
language sql
stable
security definer
set search_path = ''
as $$
	select resolution.gsd_cm
	from internal.ground_resolution(p_dataset_id) resolution
	where exists (select 1 from internal.dataset_capabilities(p_dataset_id, auth.uid()));
$$;
revoke all on function public.dataset_ground_resolution(bigint) from public;
grant execute on function public.dataset_ground_resolution(bigint) to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
