-- Restore public defaults to legacy model predictions while the combined model
-- remains available as an auditor-selectable variant. Older legacy labels were
-- written before model_config existed, so backfill those rows to the explicit
-- legacy model configs used by the current legacy processors.

update public.v2_labels
set
	model_config = '{"module":"deadwood_segmentation_v1_moehring","checkpoint_name":"segformer_b5_full_epoch_100.safetensors"}'::jsonb,
	updated_at = now()
where
	label_source = 'model_prediction'::"LabelSource"
	and label_data = 'deadwood'
	and model_config is null;

update public.v2_labels
set
	model_config = '{"module":"treecover_segmentation_oam_tcd","checkpoint_name":"restor/tcd-segformer-mit-b5"}'::jsonb,
	updated_at = now()
where
	label_source = 'model_prediction'::"LabelSource"
	and label_data = 'forest_cover'
	and model_config is null;

update public.v2_model_preferences
set
	model_config = case label_data
		when 'deadwood' then '{"module":"deadwood_segmentation_v1_moehring","checkpoint_name":"segformer_b5_full_epoch_100.safetensors"}'::jsonb
		when 'forest_cover' then '{"module":"treecover_segmentation_oam_tcd","checkpoint_name":"restor/tcd-segformer-mit-b5"}'::jsonb
	end,
	updated_at = now()
where label_data in ('deadwood', 'forest_cover');

alter table public.v2_model_preferences
	alter column model_config set not null;

create or replace view "public"."v_export_polygon_candidates" as
with correction_flags as (
	select
		c.layer_type,
		c.geometry_id,
		bool_or(c.operation = 'add' and c.review_status = 'approved') as has_approved_add,
		bool_or(c.operation = 'modify' and c.review_status = 'approved') as has_approved_modify,
		bool_or(c.operation = 'delete' and c.review_status = 'approved') as has_approved_delete,
		bool_or(c.operation = 'add' and coalesce(c.review_status, '') not in ('approved', 'rejected')) as has_pending_add,
		bool_or(c.operation = 'modify' and coalesce(c.review_status, '') not in ('approved', 'rejected')) as has_pending_modify,
		bool_or(c.operation = 'delete' and coalesce(c.review_status, '') not in ('approved', 'rejected')) as has_pending_delete
	from public.v2_geometry_corrections c
	group by
		c.layer_type,
		c.geometry_id
),
approved_replacements as (
	select
		c.layer_type,
		c.original_geometry_id as geometry_id,
		true as replaced_by_approved_modify
	from public.v2_geometry_corrections c
	where
		c.operation = 'modify'
		and c.review_status = 'approved'
		and c.original_geometry_id is not null
	group by c.layer_type, c.original_geometry_id
),
deadwood as (
	select
		'deadwood'::text as layer_type,
		dg.id as geometry_id,
		dg.label_id,
		l.dataset_id,
		l.label_source::text as label_source,
		l.is_active as label_is_active,
		coalesce(dg.is_deleted, false) as is_deleted_in_table,
		coalesce(cf.has_approved_add, false) as has_approved_add,
		coalesce(cf.has_approved_modify, false) as has_approved_modify,
		coalesce(cf.has_approved_delete, false) as has_approved_delete,
		coalesce(cf.has_pending_add, false) as has_pending_add,
		coalesce(cf.has_pending_modify, false) as has_pending_modify,
		coalesce(cf.has_pending_delete, false) as has_pending_delete,
		coalesce(ar.replaced_by_approved_modify, false) as replaced_by_approved_modify,
		dg.geometry,
		dg.area_m2,
		dg.properties,
		dg.created_at,
		dg.updated_at
	from public.v2_deadwood_geometries dg
	join public.v2_labels l on l.id = dg.label_id
	join public.v2_model_preferences mp
		on mp.label_data = 'deadwood'
		and l.model_config = mp.model_config
	left join correction_flags cf
		on cf.layer_type = 'deadwood'
		and cf.geometry_id = dg.id
	left join approved_replacements ar
		on ar.layer_type = 'deadwood'
		and ar.geometry_id = dg.id
	where l.label_source = 'model_prediction'::"LabelSource"
),
forest_cover as (
	select
		'forest_cover'::text as layer_type,
		fg.id as geometry_id,
		fg.label_id,
		l.dataset_id,
		l.label_source::text as label_source,
		l.is_active as label_is_active,
		coalesce(fg.is_deleted, false) as is_deleted_in_table,
		coalesce(cf.has_approved_add, false) as has_approved_add,
		coalesce(cf.has_approved_modify, false) as has_approved_modify,
		coalesce(cf.has_approved_delete, false) as has_approved_delete,
		coalesce(cf.has_pending_add, false) as has_pending_add,
		coalesce(cf.has_pending_modify, false) as has_pending_modify,
		coalesce(cf.has_pending_delete, false) as has_pending_delete,
		coalesce(ar.replaced_by_approved_modify, false) as replaced_by_approved_modify,
		fg.geometry,
		fg.area_m2,
		fg.properties,
		fg.created_at,
		fg.updated_at
	from public.v2_forest_cover_geometries fg
	join public.v2_labels l on l.id = fg.label_id
	join public.v2_model_preferences mp
		on mp.label_data = 'forest_cover'
		and l.model_config = mp.model_config
	left join correction_flags cf
		on cf.layer_type = 'forest_cover'
		and cf.geometry_id = fg.id
	left join approved_replacements ar
		on ar.layer_type = 'forest_cover'
		and ar.geometry_id = fg.id
	where l.label_source = 'model_prediction'::"LabelSource"
),
resolved_polygons as (
	select
		p.layer_type,
		p.geometry_id as id,
		p.label_id,
		p.dataset_id,
		p.label_source,
		case
			when p.has_approved_delete then false
			when p.replaced_by_approved_modify then false
			when p.has_approved_add or p.has_approved_modify then true
			when p.has_pending_add or p.has_pending_modify then false
			when p.has_pending_delete then true
			else not p.is_deleted_in_table
		end as is_active,
		p.is_deleted_in_table as is_deleted,
		not (
			p.has_approved_add
			or p.has_approved_modify
			or p.has_pending_add
			or p.has_pending_modify
		) as is_original_prediction_geometry,
		false as has_pending_model_edits,
		'approved_state'::text as recommended_export_mode,
		p.label_is_active,
		p.geometry,
		p.area_m2,
		p.properties,
		p.created_at,
		p.updated_at
	from (
		select * from deadwood
		union all
		select * from forest_cover
	) p
)
select
	p.layer_type,
	p.id,
	p.label_id,
	p.dataset_id,
	p.label_source,
	p.is_active,
	p.is_deleted,
	p.is_original_prediction_geometry,
	p.has_pending_model_edits,
	p.recommended_export_mode,
	da.final_assessment,
	da.deadwood_quality::text as deadwood_quality,
	da.forest_cover_quality::text as forest_cover_quality,
	p.geometry,
	p.area_m2,
	p.properties,
	p.created_at,
	p.updated_at
from resolved_polygons p
left join public.dataset_audit da on da.dataset_id = p.dataset_id
where p.is_active and p.label_is_active;

CREATE OR REPLACE FUNCTION public.get_forest_cover_tiles_with_corrections(
	z integer,
	x integer,
	y integer,
	filter_label_id bigint,
	resolution integer DEFAULT 4096,
	filter_correction_status text DEFAULT NULL::text
)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    mvt bytea;
BEGIN
    WITH
    bbox AS (
        SELECT ST_TileEnvelope(z, x, y) AS bbox_3857
    ),
    settings AS (
        SELECT
            CASE WHEN z < 6 THEN 1000000
                 WHEN z < 8 THEN 500000
                 WHEN z < 10 THEN 100000
                 WHEN z < 12 THEN 50000
                 WHEN z < 14 THEN 10000
                 ELSE 0 END AS min_area
    )
    SELECT ST_AsMVT(tile_data, 'forest_cover', resolution)
    INTO mvt
    FROM (
        SELECT
            ST_AsMVTGeom(
                ST_Transform(g.geometry, 3857),
                b.bbox_3857,
                resolution,
                128,
                true
            ) AS geom,
            g.id,
            g.label_id,
            g.properties,
            g.is_deleted,
            COALESCE(c.review_status, 'original') AS correction_status,
            c.operation AS correction_operation,
            c.id AS correction_id
        FROM
            public.v2_forest_cover_geometries g
        CROSS JOIN bbox b
        CROSS JOIN settings s
        LEFT JOIN LATERAL (
            SELECT id, review_status, operation
            FROM v2_geometry_corrections
            WHERE geometry_id = g.id AND layer_type = 'forest_cover'
            ORDER BY created_at DESC
            LIMIT 1
        ) c ON true
        WHERE
            g.label_id = filter_label_id
            AND g.area_m2 >= s.min_area
            AND g.geometry && ST_Transform(b.bbox_3857, ST_SRID(g.geometry))
            AND ST_Intersects(g.geometry, ST_Transform(b.bbox_3857, ST_SRID(g.geometry)))
            AND (
                CASE filter_correction_status
                    WHEN 'all' THEN true
                    WHEN 'pending' THEN c.review_status = 'pending'
                    ELSE g.is_deleted = false
                END
            )
        LIMIT 50000
    ) AS tile_data
    WHERE tile_data.geom IS NOT NULL;

    RETURN encode(mvt, 'base64');
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_forest_cover_vector_tiles_perf(
	z integer,
	x integer,
	y integer,
	filter_label_id integer,
	resolution integer DEFAULT 4096
)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
    mvt bytea;
BEGIN
    WITH
    bbox AS (
        SELECT ST_TileEnvelope(z, x, y) AS bbox_3857
    ),
    settings AS (
        SELECT
            CASE WHEN z < 6 THEN 1000000
                 WHEN z < 8 THEN 500000
                 WHEN z < 10 THEN 100000
                 WHEN z < 12 THEN 50000
                 WHEN z < 14 THEN 10000
                 ELSE 0 END AS min_area
    )
    SELECT ST_AsMVT(tile_data, 'forest_cover', resolution)
    INTO mvt
    FROM (
        SELECT
            ST_AsMVTGeom(
                ST_Transform(g.geometry, 3857),
                b.bbox_3857,
                resolution,
                128,
                true
            ) AS geom,
            g.id,
            g.label_id,
            g.properties,
            COALESCE(c.review_status, 'original') AS correction_status,
            c.operation AS correction_operation
        FROM
            public.v2_forest_cover_geometries g
            CROSS JOIN bbox b
            CROSS JOIN settings s
            LEFT JOIN LATERAL (
                SELECT review_status, operation
                FROM v2_geometry_corrections
                WHERE geometry_id = g.id AND layer_type = 'forest_cover'
                ORDER BY created_at DESC LIMIT 1
            ) c ON true
        WHERE
            g.label_id = filter_label_id
            AND g.is_deleted = false
            AND g.area_m2 >= s.min_area
            AND g.geometry && ST_Transform(b.bbox_3857, ST_SRID(g.geometry))
            AND ST_Intersects(g.geometry, ST_Transform(b.bbox_3857, ST_SRID(g.geometry)))
        LIMIT 50000
    ) AS tile_data
    WHERE tile_data.geom IS NOT NULL;

    RETURN encode(mvt, 'base64');
END;
$function$;
