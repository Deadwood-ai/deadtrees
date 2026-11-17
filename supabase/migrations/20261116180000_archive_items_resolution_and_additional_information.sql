-- Dataset archive filters: ground resolution and searchable additional information.
--
-- The archive list filters by ground sampling distance and searches the uploader's
-- additional information. The view keeps its columns and order;
-- CREATE OR REPLACE VIEW only appends.

begin;

-- Ground resolution of every COG, in cm per pixel. v2_cogs rows are readable only
-- by bulk COG readers (20261007090000), and the view runs as the caller, so this
-- set-based helper hands out the resolution and nothing else, such as the path.
-- All COGs are web mercator (EPSG:3857): the pixel size is scaled by
-- cos(latitude) to give metres on the ground. Resolved once per query, not per row.
create function internal.archive_ground_resolution()
returns table (dataset_id bigint, gsd_cm real)
language sql
stable
security definer
set search_path = ''
as $$
	select
		cog.dataset_id,
		round(
			((cog.cog_info -> 'GEO' -> 'Resolution' ->> 0)::numeric
			* cos(radians((public.st_ymin(ortho.bbox::public.box3d) + public.st_ymax(ortho.bbox::public.box3d)) / 2))::numeric
			* 100),
			1
		)::real
	from public.v2_cogs cog
	join public.v2_orthos ortho on ortho.dataset_id = cog.dataset_id
	where cog.cog_info -> 'GEO' ->> 'CRS' = 'EPSG:3857';
$$;
revoke all on function internal.archive_ground_resolution() from public;
grant execute on function internal.archive_ground_resolution() to anon, authenticated, service_role;

create or replace view public.public_dataset_archive_items with (security_invoker=true) as
 WITH latest_status AS (
         SELECT DISTINCT ON (v2_statuses.dataset_id) v2_statuses.dataset_id,
            v2_statuses.is_cog_done,
            v2_statuses.is_thumbnail_done,
            v2_statuses.is_deadwood_done,
            v2_statuses.is_forest_cover_done,
            v2_statuses.is_metadata_done,
            v2_statuses.has_error
           FROM v2_statuses
          ORDER BY v2_statuses.dataset_id, v2_statuses.updated_at DESC, v2_statuses.id DESC
        ), archive_base AS (
         SELECT d.id,
            d.created_at,
            d.license,
            d.platform,
            d.authors,
            d.aquisition_year,
            d.aquisition_month,
            d.aquisition_day,
            o.bbox,
            thumb.thumbnail_path,
            ((meta.metadata ->> 'gadm'::text)::jsonb) ->> 'admin_level_1'::text AS admin_level_1,
            ((meta.metadata ->> 'gadm'::text)::jsonb) ->> 'admin_level_2'::text AS admin_level_2,
            ((meta.metadata ->> 'gadm'::text)::jsonb) ->> 'admin_level_3'::text AS admin_level_3,
            ((meta.metadata ->> 'biome'::text)::jsonb) ->> 'biome_name'::text AS biome_name,
            d.data_access,
            resolution.gsd_cm,
            NULLIF(btrim(d.additional_information), ''::text) AS additional_information
           FROM v2_datasets d
             JOIN latest_status s ON s.dataset_id = d.id
             JOIN v2_orthos o ON o.dataset_id = d.id
             LEFT JOIN v2_thumbnails thumb ON thumb.dataset_id = d.id
             LEFT JOIN v2_metadata meta ON meta.dataset_id = d.id
             LEFT JOIN internal.archive_ground_resolution() resolution(dataset_id, gsd_cm) ON resolution.dataset_id = d.id
          WHERE (d.data_access <> 'private'::access OR (( SELECT auth.uid() AS uid)) = d.user_id OR ( SELECT can_view_all_private_data() AS can_view_all_private_data) OR d.id IN (SELECT internal.granted_dataset_ids())) AND d.archived = false AND s.is_cog_done = true AND s.is_thumbnail_done = true AND s.is_metadata_done = true AND (s.has_error = false OR s.is_deadwood_done = true AND s.is_forest_cover_done = false) AND NOT (d.id IN ( SELECT internal.public_surface_excluded_dataset_ids() AS public_surface_excluded_dataset_ids))
        )
 SELECT base.id,
    base.created_at,
    base.license,
    base.platform,
    base.authors,
    base.aquisition_year,
    base.aquisition_month,
    base.aquisition_day,
    base.bbox,
    base.thumbnail_path,
    base.admin_level_1,
    base.admin_level_2,
    base.admin_level_3,
    base.biome_name,
    (EXISTS ( SELECT 1
           FROM v2_labels label
          WHERE label.dataset_id = base.id AND label.label_source = 'visual_interpretation'::"LabelSource" AND label.label_data = 'deadwood'::"LabelData")) AS has_labels,
    (EXISTS ( SELECT 1
           FROM v2_labels label
          WHERE label.dataset_id = base.id AND label.label_source = 'model_prediction'::"LabelSource" AND label.label_data = 'deadwood'::"LabelData")) AS has_deadwood_prediction,
    base.data_access,
    base.gsd_cm,
    base.additional_information
   FROM archive_base base
  WHERE base.admin_level_1 IS NOT NULL;

NOTIFY pgrst, 'reload schema';

commit;
