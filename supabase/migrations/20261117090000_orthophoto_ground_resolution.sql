-- Ground resolution of the uploaded orthophoto, stored on v2_orthos.
--
-- The dataset details page shows it and the archive resolution filter uses it.
-- 20261116180000 measured the COG on every archive query; the COG is reprojected
-- to web mercator and snapped to a map zoom level, so it is often 5-50% off the
-- orthophoto. The processor now stores the orthophoto's resolution when it reads
-- the upload (shared/ortho.py); existing rows are filled once below.

begin;

alter table public.v2_orthos add column gsd_cm real;
comment on column public.v2_orthos.gsd_cm is
	'Ground size of one pixel of the uploaded orthophoto in cm, measured at its centre. Null when the CRS is unusable.';

-- One-time fill from the stored pixel size, converted from the CRS units to
-- ground metres and averaged over the pixel's width and height, as the processor
-- does: degrees and web mercator by latitude, projected CRSs by their linear
-- unit. A CRS stored as WKT uses the last unit after PROJECTION (the projected
-- unit) or the LOCAL_CS unit. Without a usable CRS the COG, always web mercator,
-- is the fallback.
with ortho as (
	select
		o.dataset_id,
		o.ortho_info -> 'GEO' ->> 'CRS' as crs,
		abs((o.ortho_info -> 'GEO' -> 'Resolution' ->> 0)::double precision) as pixel_x,
		abs((o.ortho_info -> 'GEO' -> 'Resolution' ->> 1)::double precision) as pixel_y,
		cos(radians((public.st_ymin(o.bbox::public.box3d) + public.st_ymax(o.bbox::public.box3d)) / 2)) as cos_lat
	from public.v2_orthos o
), metres as (
	select
		ortho.dataset_id,
		coalesce(
			case
				-- A degree of longitude shrinks with latitude, a degree of latitude does not.
				when srs.proj4text like '%+proj=longlat%' then
					(ortho.pixel_x * 111320 * ortho.cos_lat + ortho.pixel_y * 110574) / 2
				else (ortho.pixel_x + ortho.pixel_y) / 2 * case
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
				end
			end,
			case when cog.cog_info -> 'GEO' ->> 'CRS' = 'EPSG:3857' then
				abs((cog.cog_info -> 'GEO' -> 'Resolution' ->> 0)::double precision) * ortho.cos_lat
			end
		) as value
	from ortho
	left join public.spatial_ref_sys srs
		on srs.srid = case when ortho.crs ~ '^EPSG:[0-9]+$' then split_part(ortho.crs, ':', 2)::integer end
	left join public.v2_cogs cog on cog.dataset_id = ortho.dataset_id
)
update public.v2_orthos o
set gsd_cm = round((metres.value * 100)::numeric, 1)::real
from metres
where metres.dataset_id = o.dataset_id and metres.value is not null;

-- The archive view keeps calling this helper; it now reads the stored value.
create or replace function internal.archive_ground_resolution()
returns table (dataset_id bigint, gsd_cm real)
language sql
stable
security definer
set search_path = ''
as $$
	select o.dataset_id, o.gsd_cm
	from public.v2_orthos o
	where o.gsd_cm is not null;
$$;

notify pgrst, 'reload schema';

commit;
