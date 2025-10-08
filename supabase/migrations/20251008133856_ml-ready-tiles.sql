create sequence "public"."ml_training_tiles_id_seq";

drop view if exists "public"."v2_full_dataset_view_public";

create table "public"."ml_training_tiles" (
    "id" bigint not null default nextval('ml_training_tiles_id_seq'::regclass),
    "dataset_id" bigint not null,
    "user_id" uuid not null,
    "resolution_cm" integer not null,
    "geometry" jsonb not null,
    "parent_tile_id" bigint,
    "status" text not null default 'pending'::text,
    "tile_index" character varying(50) not null,
    "bbox_minx" double precision not null,
    "bbox_miny" double precision not null,
    "bbox_maxx" double precision not null,
    "bbox_maxy" double precision not null,
    "aoi_coverage_percent" smallint,
    "deadwood_prediction_coverage_percent" smallint,
    "forest_cover_prediction_coverage_percent" smallint,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
);


alter table "public"."ml_training_tiles" enable row level security;

alter table "public"."v2_statuses" add column "has_ml_tiles" boolean default false;

alter table "public"."v2_statuses" add column "is_in_tile_generation" boolean default false;

alter table "public"."v2_statuses" add column "ml_tiles_completed_at" timestamp with time zone;

alter table "public"."v2_statuses" add column "tile_generation_locked_at" timestamp with time zone;

alter table "public"."v2_statuses" add column "tile_generation_locked_by" uuid;

alter sequence "public"."ml_training_tiles_id_seq" owned by "public"."ml_training_tiles"."id";

CREATE INDEX idx_ml_tiles_dataset ON public.ml_training_tiles USING btree (dataset_id);

CREATE INDEX idx_ml_tiles_parent ON public.ml_training_tiles USING btree (parent_tile_id) WHERE (parent_tile_id IS NOT NULL);

CREATE INDEX idx_ml_tiles_resolution ON public.ml_training_tiles USING btree (resolution_cm);

CREATE INDEX idx_ml_tiles_status ON public.ml_training_tiles USING btree (status, resolution_cm);

CREATE INDEX idx_statuses_tile_lock ON public.v2_statuses USING btree (is_in_tile_generation, dataset_id);

CREATE UNIQUE INDEX ml_tiles_unique_index ON public.ml_training_tiles USING btree (dataset_id, tile_index);

CREATE UNIQUE INDEX ml_training_tiles_pkey ON public.ml_training_tiles USING btree (id);

alter table "public"."ml_training_tiles" add constraint "ml_training_tiles_pkey" PRIMARY KEY using index "ml_training_tiles_pkey";

alter table "public"."ml_training_tiles" add constraint "ml_tiles_unique_index" UNIQUE using index "ml_tiles_unique_index";

alter table "public"."ml_training_tiles" add constraint "ml_training_tiles_aoi_coverage_percent_check" CHECK (((aoi_coverage_percent >= 0) AND (aoi_coverage_percent <= 100))) not valid;

alter table "public"."ml_training_tiles" validate constraint "ml_training_tiles_aoi_coverage_percent_check";

alter table "public"."ml_training_tiles" add constraint "ml_training_tiles_dataset_id_fkey" FOREIGN KEY (dataset_id) REFERENCES v2_datasets(id) ON DELETE CASCADE not valid;

alter table "public"."ml_training_tiles" validate constraint "ml_training_tiles_dataset_id_fkey";

alter table "public"."ml_training_tiles" add constraint "ml_training_tiles_deadwood_prediction_coverage_percent_check" CHECK (((deadwood_prediction_coverage_percent >= 0) AND (deadwood_prediction_coverage_percent <= 100))) not valid;

alter table "public"."ml_training_tiles" validate constraint "ml_training_tiles_deadwood_prediction_coverage_percent_check";

alter table "public"."ml_training_tiles" add constraint "ml_training_tiles_forest_cover_prediction_coverage_percen_check" CHECK (((forest_cover_prediction_coverage_percent >= 0) AND (forest_cover_prediction_coverage_percent <= 100))) not valid;

alter table "public"."ml_training_tiles" validate constraint "ml_training_tiles_forest_cover_prediction_coverage_percen_check";

alter table "public"."ml_training_tiles" add constraint "ml_training_tiles_parent_tile_id_fkey" FOREIGN KEY (parent_tile_id) REFERENCES ml_training_tiles(id) ON DELETE CASCADE not valid;

alter table "public"."ml_training_tiles" validate constraint "ml_training_tiles_parent_tile_id_fkey";

alter table "public"."ml_training_tiles" add constraint "ml_training_tiles_resolution_cm_check" CHECK ((resolution_cm = ANY (ARRAY[5, 10, 20]))) not valid;

alter table "public"."ml_training_tiles" validate constraint "ml_training_tiles_resolution_cm_check";

alter table "public"."ml_training_tiles" add constraint "ml_training_tiles_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'good'::text, 'bad'::text]))) not valid;

alter table "public"."ml_training_tiles" validate constraint "ml_training_tiles_status_check";

alter table "public"."ml_training_tiles" add constraint "ml_training_tiles_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) not valid;

alter table "public"."ml_training_tiles" validate constraint "ml_training_tiles_user_id_fkey";

alter table "public"."v2_statuses" add constraint "v2_statuses_tile_generation_locked_by_fkey" FOREIGN KEY (tile_generation_locked_by) REFERENCES auth.users(id) not valid;

alter table "public"."v2_statuses" validate constraint "v2_statuses_tile_generation_locked_by_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.get_deadwood_vector_tiles_perf1(z integer, x integer, y integer, filter_label_id integer, resolution integer DEFAULT 4096)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
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
            -- Optimized thresholds for small deadwood polygons
            CASE WHEN z < 8 THEN 200000
                 WHEN z < 10 THEN 20000
                 WHEN z < 12 THEN 2000
                 WHEN z < 14 THEN 200
                 ELSE 0 END AS min_area,
            -- Simplification for lower zooms
            CASE WHEN z < 10 THEN 10.0
                 WHEN z < 12 THEN 5.0
                 ELSE 0.0 END AS simplify_tolerance
    )
    SELECT ST_AsMVT(tile_data, 'deadwood', resolution)
    INTO mvt
    FROM (
        SELECT
            ST_AsMVTGeom(
                ST_Transform(
                    -- Apply simplification for lower zoom levels
                    CASE 
                        WHEN s.simplify_tolerance > 0 THEN 
                            ST_SimplifyPreserveTopology(g.geometry, s.simplify_tolerance)
                        ELSE 
                            g.geometry
                    END,
                    3857
                ),
                b.bbox_3857,
                resolution,
                128,  -- Smaller buffer for small deadwood polygons
                true
            ) AS geom,
            g.id,
            g.label_id,
            g.properties
        FROM
            public.v2_deadwood_geometries g,
            bbox b,
            settings s
        WHERE
            g.label_id = filter_label_id
            AND g.area_m2 >= s.min_area
            AND g.geometry && ST_Transform(b.bbox_3857, ST_SRID(g.geometry))
            AND ST_Intersects(
                g.geometry,
                ST_Transform(b.bbox_3857, ST_SRID(g.geometry))
            )
        LIMIT 50000  -- Reduced from 100000
    ) AS tile_data
    WHERE tile_data.geom IS NOT NULL;

    RETURN encode(mvt, 'base64');
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_forest_cover_vector_tiles_perf(z integer, x integer, y integer, filter_label_id integer, resolution integer DEFAULT 4096)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
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
            -- Doubled thresholds for large forest cover polygons
            CASE WHEN z < 6 THEN 2000000   -- 200 hectares for very low zoom
                 WHEN z < 8 THEN 1000000   -- 100 hectares
                 WHEN z < 10 THEN 200000   -- 20 hectares  
                 WHEN z < 12 THEN 100000   -- 10 hectares
                 WHEN z < 14 THEN 20000    -- 2 hectares
                 ELSE 0 END AS min_area,
            -- Simplification tolerance based on zoom level
            CASE WHEN z < 8 THEN 50.0
                 WHEN z < 10 THEN 20.0
                 WHEN z < 12 THEN 10.0
                 WHEN z < 14 THEN 5.0
                 ELSE 0.0 END AS simplify_tolerance
    )
    SELECT ST_AsMVT(tile_data, 'forest_cover', resolution)
    INTO mvt
    FROM (
        SELECT
            ST_AsMVTGeom(
                ST_Transform(
                    -- Apply simplification for lower zoom levels
                    CASE 
                        WHEN s.simplify_tolerance > 0 THEN 
                            ST_SimplifyPreserveTopology(g.geometry, s.simplify_tolerance)
                        ELSE 
                            g.geometry
                    END,
                    3857
                ),
                b.bbox_3857,
                resolution,
                64,  -- Reduced buffer for better performance (was 128)
                true
            ) AS geom,
            g.id,
            g.label_id,
            g.properties
        FROM
            public.v2_forest_cover_geometries g,
            bbox b,
            settings s
        WHERE
            g.label_id = filter_label_id
            AND g.area_m2 >= s.min_area
            AND g.geometry && ST_Transform(b.bbox_3857, ST_SRID(g.geometry))
            AND ST_Intersects(
                g.geometry,
                ST_Transform(b.bbox_3857, ST_SRID(g.geometry))
            )
        LIMIT 25000  -- Reduced from 50000 for better response times
    ) AS tile_data
    WHERE tile_data.geom IS NOT NULL;

    RETURN encode(mvt, 'base64');
END;
$function$
;

create or replace view "public"."v2_full_dataset_view" as  WITH ds AS (
         SELECT v2_datasets.id,
            v2_datasets.user_id,
            v2_datasets.created_at,
            v2_datasets.file_name,
            v2_datasets.license,
            v2_datasets.platform,
            v2_datasets.project_id,
            v2_datasets.authors,
            v2_datasets.aquisition_year,
            v2_datasets.aquisition_month,
            v2_datasets.aquisition_day,
            v2_datasets.additional_information,
            v2_datasets.data_access,
            v2_datasets.citation_doi
           FROM v2_datasets
          WHERE ((v2_datasets.data_access <> 'private'::access) OR (auth.uid() = v2_datasets.user_id) OR can_view_all_private_data())
        ), ortho AS (
         SELECT v2_orthos.dataset_id,
            v2_orthos.ortho_file_name,
            v2_orthos.ortho_file_size,
            v2_orthos.bbox,
            v2_orthos.sha256,
            v2_orthos.ortho_upload_runtime
           FROM v2_orthos
        ), status AS (
         SELECT v2_statuses.dataset_id,
            v2_statuses.current_status,
            v2_statuses.is_upload_done,
            v2_statuses.is_ortho_done,
            v2_statuses.is_cog_done,
            v2_statuses.is_thumbnail_done,
            v2_statuses.is_deadwood_done,
            v2_statuses.is_forest_cover_done,
            v2_statuses.is_metadata_done,
            v2_statuses.is_odm_done,
            v2_statuses.is_audited,
            v2_statuses.has_error,
            v2_statuses.error_message,
            v2_statuses.has_ml_tiles,
            v2_statuses.ml_tiles_completed_at
           FROM v2_statuses
        ), extra AS (
         SELECT ds_1.id AS dataset_id,
            cog.cog_file_name,
            cog.cog_path,
            cog.cog_file_size,
            thumb.thumbnail_file_name,
            thumb.thumbnail_path,
            (meta.metadata ->> 'gadm'::text) AS admin_metadata,
            (meta.metadata ->> 'biome'::text) AS biome_metadata
           FROM (((v2_datasets ds_1
             LEFT JOIN v2_cogs cog ON ((cog.dataset_id = ds_1.id)))
             LEFT JOIN v2_thumbnails thumb ON ((thumb.dataset_id = ds_1.id)))
             LEFT JOIN v2_metadata meta ON ((meta.dataset_id = ds_1.id)))
          WHERE ((ds_1.data_access <> 'private'::access) OR (auth.uid() = ds_1.user_id) OR can_view_all_private_data())
        ), label_info AS (
         SELECT dataset.id AS dataset_id,
            (EXISTS ( SELECT 1
                   FROM v2_labels
                  WHERE ((v2_labels.dataset_id = dataset.id) AND (v2_labels.label_source = 'visual_interpretation'::"LabelSource") AND (v2_labels.label_data = 'deadwood'::"LabelData")))) AS has_labels,
            (EXISTS ( SELECT 1
                   FROM v2_labels
                  WHERE ((v2_labels.dataset_id = dataset.id) AND (v2_labels.label_source = 'model_prediction'::"LabelSource") AND (v2_labels.label_data = 'deadwood'::"LabelData")))) AS has_deadwood_prediction
           FROM v2_datasets dataset
          WHERE ((dataset.data_access <> 'private'::access) OR (auth.uid() = dataset.user_id) OR can_view_all_private_data())
        ), freidata_doi AS (
         SELECT jt.dataset_id,
            dp.doi AS freidata_doi
           FROM (jt_data_publication_datasets jt
             JOIN data_publication dp ON ((dp.id = jt.publication_id)))
          WHERE (dp.doi IS NOT NULL)
        )
 SELECT ds.id,
    ds.user_id,
    ds.created_at,
    ds.file_name,
    ds.license,
    ds.platform,
    ds.project_id,
    ds.authors,
    ds.aquisition_year,
    ds.aquisition_month,
    ds.aquisition_day,
    ds.additional_information,
    ds.data_access,
    ds.citation_doi,
    ortho.ortho_file_name,
    ortho.ortho_file_size,
    ortho.bbox,
    ortho.sha256,
    status.current_status,
    status.is_upload_done,
    status.is_ortho_done,
    status.is_cog_done,
    status.is_thumbnail_done,
    status.is_deadwood_done,
    status.is_forest_cover_done,
    status.is_metadata_done,
    status.is_odm_done,
    status.is_audited,
    status.has_error,
    status.error_message,
    extra.cog_file_name,
    extra.cog_path,
    extra.cog_file_size,
    extra.thumbnail_file_name,
    extra.thumbnail_path,
    ((extra.admin_metadata)::jsonb ->> 'admin_level_1'::text) AS admin_level_1,
    ((extra.admin_metadata)::jsonb ->> 'admin_level_2'::text) AS admin_level_2,
    ((extra.admin_metadata)::jsonb ->> 'admin_level_3'::text) AS admin_level_3,
    ((extra.biome_metadata)::jsonb ->> 'biome_name'::text) AS biome_name,
    label_info.has_labels,
    label_info.has_deadwood_prediction,
    freidata_doi.freidata_doi,
    status.has_ml_tiles,
    status.ml_tiles_completed_at
   FROM (((((ds
     LEFT JOIN ortho ON ((ortho.dataset_id = ds.id)))
     LEFT JOIN status ON ((status.dataset_id = ds.id)))
     LEFT JOIN extra ON ((extra.dataset_id = ds.id)))
     LEFT JOIN label_info ON ((label_info.dataset_id = ds.id)))
     LEFT JOIN freidata_doi ON ((freidata_doi.dataset_id = ds.id)));


create or replace view "public"."v2_full_dataset_view_public" as  SELECT base.id,
    base.user_id,
    base.created_at,
    base.file_name,
    base.license,
    base.platform,
    base.project_id,
    base.authors,
    base.aquisition_year,
    base.aquisition_month,
    base.aquisition_day,
    base.additional_information,
    base.data_access,
    base.citation_doi,
    base.ortho_file_name,
    base.ortho_file_size,
    base.bbox,
    base.sha256,
    base.current_status,
    base.is_upload_done,
    base.is_ortho_done,
    base.is_cog_done,
    base.is_thumbnail_done,
    base.is_deadwood_done,
    base.is_forest_cover_done,
    base.is_metadata_done,
    base.is_odm_done,
    base.is_audited,
    base.has_error,
    base.error_message,
    base.cog_file_name,
    base.cog_path,
    base.cog_file_size,
    base.thumbnail_file_name,
    base.thumbnail_path,
    base.admin_level_1,
    base.admin_level_2,
    base.admin_level_3,
    base.biome_name,
    base.has_labels,
    base.has_deadwood_prediction,
    base.freidata_doi,
    base.has_ml_tiles,
    base.ml_tiles_completed_at,
    audit_data.final_assessment,
    audit_data.deadwood_quality,
    audit_data.forest_cover_quality,
    audit_data.has_major_issue,
    audit_data.audit_date,
    audit_data.audited_by,
    audit_data.audited_by_email,
        CASE
            WHEN (audit_data.deadwood_quality = 'bad'::prediction_quality) THEN false
            WHEN (audit_data.deadwood_quality = ANY (ARRAY['great'::prediction_quality, 'sentinel_ok'::prediction_quality])) THEN true
            WHEN ((audit_data.deadwood_quality IS NULL) AND (base.is_audited = true)) THEN false
            ELSE true
        END AS show_deadwood_predictions,
        CASE
            WHEN (audit_data.forest_cover_quality = 'bad'::prediction_quality) THEN false
            WHEN (audit_data.forest_cover_quality = ANY (ARRAY['great'::prediction_quality, 'sentinel_ok'::prediction_quality])) THEN true
            WHEN ((audit_data.forest_cover_quality IS NULL) AND (base.is_audited = true)) THEN false
            ELSE true
        END AS show_forest_cover_predictions
   FROM (v2_full_dataset_view base
     LEFT JOIN ( SELECT da.dataset_id,
            da.final_assessment,
            da.deadwood_quality,
            da.forest_cover_quality,
            da.has_major_issue,
            da.audit_date,
            da.audited_by,
            au.email AS audited_by_email
           FROM (dataset_audit da
             LEFT JOIN auth.users au ON ((da.audited_by = au.id)))) audit_data ON ((audit_data.dataset_id = base.id)))
  WHERE ((audit_data.final_assessment IS NULL) OR (audit_data.final_assessment <> 'exclude_completely'::text));


grant delete on table "public"."ml_training_tiles" to "anon";

grant insert on table "public"."ml_training_tiles" to "anon";

grant references on table "public"."ml_training_tiles" to "anon";

grant select on table "public"."ml_training_tiles" to "anon";

grant trigger on table "public"."ml_training_tiles" to "anon";

grant truncate on table "public"."ml_training_tiles" to "anon";

grant update on table "public"."ml_training_tiles" to "anon";

grant delete on table "public"."ml_training_tiles" to "authenticated";

grant insert on table "public"."ml_training_tiles" to "authenticated";

grant references on table "public"."ml_training_tiles" to "authenticated";

grant select on table "public"."ml_training_tiles" to "authenticated";

grant trigger on table "public"."ml_training_tiles" to "authenticated";

grant truncate on table "public"."ml_training_tiles" to "authenticated";

grant update on table "public"."ml_training_tiles" to "authenticated";

grant delete on table "public"."ml_training_tiles" to "service_role";

grant insert on table "public"."ml_training_tiles" to "service_role";

grant references on table "public"."ml_training_tiles" to "service_role";

grant select on table "public"."ml_training_tiles" to "service_role";

grant trigger on table "public"."ml_training_tiles" to "service_role";

grant truncate on table "public"."ml_training_tiles" to "service_role";

grant update on table "public"."ml_training_tiles" to "service_role";

create policy "Auditors can manage tiles"
on "public"."ml_training_tiles"
as permissive
for all
to public
using ((auth.uid() IN ( SELECT privileged_users.user_id
   FROM privileged_users
  WHERE (privileged_users.can_audit = true))));


create policy "Auditors can view all tiles"
on "public"."ml_training_tiles"
as permissive
for select
to public
using ((auth.uid() IN ( SELECT privileged_users.user_id
   FROM privileged_users
  WHERE (privileged_users.can_audit = true))));



