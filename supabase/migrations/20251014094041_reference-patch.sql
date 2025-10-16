create sequence "public"."reference_patch_deadwood_geometries_id_seq";

create sequence "public"."reference_patch_forest_cover_geometries_id_seq";

create sequence "public"."reference_patches_id_seq";

drop policy "Auditors can manage tiles" on "public"."ml_training_tiles";

drop policy "Auditors can view all tiles" on "public"."ml_training_tiles";

revoke delete on table "public"."ml_training_tiles" from "anon";

revoke insert on table "public"."ml_training_tiles" from "anon";

revoke references on table "public"."ml_training_tiles" from "anon";

revoke select on table "public"."ml_training_tiles" from "anon";

revoke trigger on table "public"."ml_training_tiles" from "anon";

revoke truncate on table "public"."ml_training_tiles" from "anon";

revoke update on table "public"."ml_training_tiles" from "anon";

revoke delete on table "public"."ml_training_tiles" from "authenticated";

revoke insert on table "public"."ml_training_tiles" from "authenticated";

revoke references on table "public"."ml_training_tiles" from "authenticated";

revoke select on table "public"."ml_training_tiles" from "authenticated";

revoke trigger on table "public"."ml_training_tiles" from "authenticated";

revoke truncate on table "public"."ml_training_tiles" from "authenticated";

revoke update on table "public"."ml_training_tiles" from "authenticated";

revoke delete on table "public"."ml_training_tiles" from "service_role";

revoke insert on table "public"."ml_training_tiles" from "service_role";

revoke references on table "public"."ml_training_tiles" from "service_role";

revoke select on table "public"."ml_training_tiles" from "service_role";

revoke trigger on table "public"."ml_training_tiles" from "service_role";

revoke truncate on table "public"."ml_training_tiles" from "service_role";

revoke update on table "public"."ml_training_tiles" from "service_role";

alter table "public"."ml_training_tiles" drop constraint "ml_tiles_unique_index";

alter table "public"."ml_training_tiles" drop constraint "ml_training_tiles_aoi_coverage_percent_check";

alter table "public"."ml_training_tiles" drop constraint "ml_training_tiles_dataset_id_fkey";

alter table "public"."ml_training_tiles" drop constraint "ml_training_tiles_deadwood_prediction_coverage_percent_check";

alter table "public"."ml_training_tiles" drop constraint "ml_training_tiles_forest_cover_prediction_coverage_percen_check";

alter table "public"."ml_training_tiles" drop constraint "ml_training_tiles_parent_tile_id_fkey";

alter table "public"."ml_training_tiles" drop constraint "ml_training_tiles_resolution_cm_check";

alter table "public"."ml_training_tiles" drop constraint "ml_training_tiles_status_check";

alter table "public"."ml_training_tiles" drop constraint "ml_training_tiles_user_id_fkey";

drop view if exists "public"."dev_full_dataset_view";

drop view if exists "public"."v1_full_dataset_view";

drop view if exists "public"."v2_full_dataset_view_public";

drop view if exists "public"."v2_full_dataset_view";

alter table "public"."ml_training_tiles" drop constraint "ml_training_tiles_pkey";

drop index if exists "public"."idx_ml_tiles_dataset";

drop index if exists "public"."idx_ml_tiles_parent";

drop index if exists "public"."idx_ml_tiles_resolution";

drop index if exists "public"."idx_ml_tiles_status";

drop index if exists "public"."ml_tiles_unique_index";

drop index if exists "public"."ml_training_tiles_pkey";

drop table "public"."ml_training_tiles";

alter type "public"."LabelSource" rename to "LabelSource__old_version_to_be_dropped";

create type "public"."LabelSource" as enum ('visual_interpretation', 'model_prediction', 'fixed_model_prediction', 'reference_patch');

create table "public"."reference_patch_deadwood_geometries" (
    "id" bigint not null default nextval('reference_patch_deadwood_geometries_id_seq'::regclass),
    "label_id" bigint not null,
    "patch_id" bigint not null,
    "geometry" jsonb not null,
    "area_m2" double precision,
    "properties" jsonb,
    "created_at" timestamp with time zone not null default now()
);


alter table "public"."reference_patch_deadwood_geometries" enable row level security;

create table "public"."reference_patch_forest_cover_geometries" (
    "id" bigint not null default nextval('reference_patch_forest_cover_geometries_id_seq'::regclass),
    "label_id" bigint not null,
    "patch_id" bigint not null,
    "geometry" jsonb not null,
    "area_m2" double precision,
    "properties" jsonb,
    "created_at" timestamp with time zone not null default now()
);


alter table "public"."reference_patch_forest_cover_geometries" enable row level security;

create table "public"."reference_patches" (
    "id" bigint not null default nextval('reference_patches_id_seq'::regclass),
    "dataset_id" bigint not null,
    "user_id" uuid not null,
    "resolution_cm" integer not null,
    "geometry" jsonb not null,
    "parent_tile_id" bigint,
    "status" text not null default 'pending'::text,
    "patch_index" character varying(50) not null,
    "bbox_minx" double precision not null,
    "bbox_miny" double precision not null,
    "bbox_maxx" double precision not null,
    "bbox_maxy" double precision not null,
    "aoi_coverage_percent" smallint,
    "deadwood_prediction_coverage_percent" smallint,
    "forest_cover_prediction_coverage_percent" smallint,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "reference_deadwood_label_id" bigint,
    "reference_forest_cover_label_id" bigint
);


alter table "public"."reference_patches" enable row level security;

alter table "public"."dev_labels" alter column label_source type "public"."LabelSource" using label_source::text::"public"."LabelSource";

alter table "public"."v1_labels" alter column label_source type "public"."LabelSource" using label_source::text::"public"."LabelSource";

alter table "public"."v2_labels" alter column label_source type "public"."LabelSource" using label_source::text::"public"."LabelSource";

drop type "public"."LabelSource__old_version_to_be_dropped";

alter table "public"."v2_labels" add column "is_active" boolean not null default true;

alter table "public"."v2_labels" add column "parent_label_id" bigint;

alter table "public"."v2_labels" add column "reference_patch_id" bigint;

alter table "public"."v2_labels" add column "version" integer not null default 1;

alter sequence "public"."reference_patch_deadwood_geometries_id_seq" owned by "public"."reference_patch_deadwood_geometries"."id";

alter sequence "public"."reference_patch_forest_cover_geometries_id_seq" owned by "public"."reference_patch_forest_cover_geometries"."id";

alter sequence "public"."reference_patches_id_seq" owned by "public"."reference_patches"."id";

drop sequence if exists "public"."ml_training_tiles_id_seq";

CREATE INDEX idx_labels_parent ON public.v2_labels USING btree (parent_label_id) WHERE (parent_label_id IS NOT NULL);

CREATE INDEX idx_labels_patch ON public.v2_labels USING btree (reference_patch_id) WHERE (reference_patch_id IS NOT NULL);

CREATE INDEX idx_labels_version_active ON public.v2_labels USING btree (reference_patch_id, version, is_active) WHERE (reference_patch_id IS NOT NULL);

CREATE INDEX idx_patches_ref_deadwood ON public.reference_patches USING btree (reference_deadwood_label_id) WHERE (reference_deadwood_label_id IS NOT NULL);

CREATE INDEX idx_patches_ref_forest ON public.reference_patches USING btree (reference_forest_cover_label_id) WHERE (reference_forest_cover_label_id IS NOT NULL);

CREATE INDEX idx_ref_deadwood_label ON public.reference_patch_deadwood_geometries USING btree (label_id);

CREATE INDEX idx_ref_deadwood_patch ON public.reference_patch_deadwood_geometries USING btree (patch_id);

CREATE INDEX idx_ref_forest_label ON public.reference_patch_forest_cover_geometries USING btree (label_id);

CREATE INDEX idx_ref_forest_patch ON public.reference_patch_forest_cover_geometries USING btree (patch_id);

CREATE INDEX idx_ref_patches_dataset ON public.reference_patches USING btree (dataset_id);

CREATE INDEX idx_ref_patches_parent ON public.reference_patches USING btree (parent_tile_id) WHERE (parent_tile_id IS NOT NULL);

CREATE INDEX idx_ref_patches_resolution ON public.reference_patches USING btree (resolution_cm);

CREATE INDEX idx_ref_patches_status ON public.reference_patches USING btree (status, resolution_cm);

CREATE UNIQUE INDEX reference_patch_deadwood_geometries_pkey ON public.reference_patch_deadwood_geometries USING btree (id);

CREATE UNIQUE INDEX reference_patch_forest_cover_geometries_pkey ON public.reference_patch_forest_cover_geometries USING btree (id);

CREATE UNIQUE INDEX reference_patches_pkey ON public.reference_patches USING btree (id);

CREATE UNIQUE INDEX reference_patches_unique_patch_index ON public.reference_patches USING btree (dataset_id, patch_index);

alter table "public"."reference_patch_deadwood_geometries" add constraint "reference_patch_deadwood_geometries_pkey" PRIMARY KEY using index "reference_patch_deadwood_geometries_pkey";

alter table "public"."reference_patch_forest_cover_geometries" add constraint "reference_patch_forest_cover_geometries_pkey" PRIMARY KEY using index "reference_patch_forest_cover_geometries_pkey";

alter table "public"."reference_patches" add constraint "reference_patches_pkey" PRIMARY KEY using index "reference_patches_pkey";

alter table "public"."reference_patch_deadwood_geometries" add constraint "fk_ref_deadwood_label" FOREIGN KEY (label_id) REFERENCES v2_labels(id) ON DELETE CASCADE not valid;

alter table "public"."reference_patch_deadwood_geometries" validate constraint "fk_ref_deadwood_label";

alter table "public"."reference_patch_deadwood_geometries" add constraint "fk_ref_deadwood_patch" FOREIGN KEY (patch_id) REFERENCES reference_patches(id) ON DELETE CASCADE not valid;

alter table "public"."reference_patch_deadwood_geometries" validate constraint "fk_ref_deadwood_patch";

alter table "public"."reference_patch_forest_cover_geometries" add constraint "fk_ref_forest_cover_label" FOREIGN KEY (label_id) REFERENCES v2_labels(id) ON DELETE CASCADE not valid;

alter table "public"."reference_patch_forest_cover_geometries" validate constraint "fk_ref_forest_cover_label";

alter table "public"."reference_patch_forest_cover_geometries" add constraint "fk_ref_forest_cover_patch" FOREIGN KEY (patch_id) REFERENCES reference_patches(id) ON DELETE CASCADE not valid;

alter table "public"."reference_patch_forest_cover_geometries" validate constraint "fk_ref_forest_cover_patch";

alter table "public"."reference_patches" add constraint "fk_patches_ref_deadwood_label" FOREIGN KEY (reference_deadwood_label_id) REFERENCES v2_labels(id) ON DELETE SET NULL not valid;

alter table "public"."reference_patches" validate constraint "fk_patches_ref_deadwood_label";

alter table "public"."reference_patches" add constraint "fk_patches_ref_forest_cover_label" FOREIGN KEY (reference_forest_cover_label_id) REFERENCES v2_labels(id) ON DELETE SET NULL not valid;

alter table "public"."reference_patches" validate constraint "fk_patches_ref_forest_cover_label";

alter table "public"."reference_patches" add constraint "ml_training_tiles_aoi_coverage_percent_check" CHECK (((aoi_coverage_percent >= 0) AND (aoi_coverage_percent <= 100))) not valid;

alter table "public"."reference_patches" validate constraint "ml_training_tiles_aoi_coverage_percent_check";

alter table "public"."reference_patches" add constraint "ml_training_tiles_dataset_id_fkey" FOREIGN KEY (dataset_id) REFERENCES v2_datasets(id) ON DELETE CASCADE not valid;

alter table "public"."reference_patches" validate constraint "ml_training_tiles_dataset_id_fkey";

alter table "public"."reference_patches" add constraint "ml_training_tiles_deadwood_prediction_coverage_percent_check" CHECK (((deadwood_prediction_coverage_percent >= 0) AND (deadwood_prediction_coverage_percent <= 100))) not valid;

alter table "public"."reference_patches" validate constraint "ml_training_tiles_deadwood_prediction_coverage_percent_check";

alter table "public"."reference_patches" add constraint "ml_training_tiles_forest_cover_prediction_coverage_percen_check" CHECK (((forest_cover_prediction_coverage_percent >= 0) AND (forest_cover_prediction_coverage_percent <= 100))) not valid;

alter table "public"."reference_patches" validate constraint "ml_training_tiles_forest_cover_prediction_coverage_percen_check";

alter table "public"."reference_patches" add constraint "ml_training_tiles_parent_tile_id_fkey" FOREIGN KEY (parent_tile_id) REFERENCES reference_patches(id) ON DELETE CASCADE not valid;

alter table "public"."reference_patches" validate constraint "ml_training_tiles_parent_tile_id_fkey";

alter table "public"."reference_patches" add constraint "ml_training_tiles_resolution_cm_check" CHECK ((resolution_cm = ANY (ARRAY[5, 10, 20]))) not valid;

alter table "public"."reference_patches" validate constraint "ml_training_tiles_resolution_cm_check";

alter table "public"."reference_patches" add constraint "ml_training_tiles_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'good'::text, 'bad'::text]))) not valid;

alter table "public"."reference_patches" validate constraint "ml_training_tiles_status_check";

alter table "public"."reference_patches" add constraint "ml_training_tiles_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) not valid;

alter table "public"."reference_patches" validate constraint "ml_training_tiles_user_id_fkey";

alter table "public"."reference_patches" add constraint "reference_patches_unique_patch_index" UNIQUE using index "reference_patches_unique_patch_index";

alter table "public"."v2_labels" add constraint "fk_labels_reference_patch" FOREIGN KEY (reference_patch_id) REFERENCES reference_patches(id) ON DELETE CASCADE not valid;

alter table "public"."v2_labels" validate constraint "fk_labels_reference_patch";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.copy_and_clip_reference_geometries(p_patch_id bigint, p_dataset_id bigint, p_user_id uuid, p_buffer_meters double precision DEFAULT 2.0)
 RETURNS TABLE(deadwood_label_id bigint, deadwood_count integer, forest_cover_label_id bigint, forest_cover_count integer)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_patch RECORD;
  v_patch_geom GEOMETRY;
  v_deadwood_label_id BIGINT;
  v_forest_cover_label_id BIGINT;
  v_deadwood_pred_label_id BIGINT;
  v_forest_pred_label_id BIGINT;
  v_deadwood_count INTEGER := 0;
  v_forest_count INTEGER := 0;
BEGIN
  -- Get patch details
  SELECT 
    id,
    ST_GeomFromGeoJSON(geometry::text) as geom,
    bbox_minx,
    bbox_miny,
    bbox_maxx,
    bbox_maxy
  INTO v_patch
  FROM reference_patches
  WHERE id = p_patch_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Patch % not found', p_patch_id;
  END IF;

  -- Create buffered bbox in EPSG:3857 (meters)
  v_patch_geom := ST_MakeEnvelope(
    v_patch.bbox_minx - p_buffer_meters,
    v_patch.bbox_miny - p_buffer_meters,
    v_patch.bbox_maxx + p_buffer_meters,
    v_patch.bbox_maxy + p_buffer_meters,
    3857
  );

  -- Find model prediction labels
  SELECT id INTO v_deadwood_pred_label_id
  FROM v2_labels
  WHERE dataset_id = p_dataset_id
    AND label_data = 'deadwood'
    AND label_source = 'model_prediction'
  LIMIT 1;

  SELECT id INTO v_forest_pred_label_id
  FROM v2_labels
  WHERE dataset_id = p_dataset_id
    AND label_data = 'forest_cover'
    AND label_source = 'model_prediction'
  LIMIT 1;

  -- Process DEADWOOD geometries
  IF v_deadwood_pred_label_id IS NOT NULL THEN
    -- Create reference label for deadwood
    INSERT INTO v2_labels (
      dataset_id,
      user_id,
      label_data,
      label_type,
      label_source,
      reference_patch_id,
      version,
      is_active
    ) VALUES (
      p_dataset_id,
      p_user_id,
      'deadwood',
      'semantic_segmentation',
      'reference_patch',
      p_patch_id,
      1,
      true
    )
    RETURNING id INTO v_deadwood_label_id;

    -- Copy and clip deadwood geometries
    WITH clipped_geoms AS (
      SELECT 
        v_deadwood_label_id as label_id,
        p_patch_id as patch_id,
        ST_Intersection(
          ST_Transform(ST_GeomFromGeoJSON((geometry)::text), 3857),
          v_patch_geom
        ) as clipped_geom,
        ST_Area(
          ST_Intersection(
            ST_Transform(ST_GeomFromGeoJSON((geometry)::text), 3857),
            v_patch_geom
          )
        ) as area_m2
      FROM v2_deadwood_geometries
      WHERE label_id = v_deadwood_pred_label_id
        AND ST_Intersects(
          ST_Transform(ST_GeomFromGeoJSON((geometry)::text), 3857),
          v_patch_geom
        )
    )
    INSERT INTO reference_patch_deadwood_geometries (
      label_id,
      patch_id,
      geometry,
      area_m2
    )
    SELECT 
      label_id,
      patch_id,
      ST_AsGeoJSON(ST_Transform(clipped_geom, 4326))::jsonb as geometry,
      area_m2
    FROM clipped_geoms
    WHERE ST_GeometryType(clipped_geom) IN ('ST_Polygon', 'ST_MultiPolygon')
      AND area_m2 > 0.1; -- Filter out tiny slivers

    GET DIAGNOSTICS v_deadwood_count = ROW_COUNT;

    -- Update patch with reference label ID
    UPDATE reference_patches
    SET reference_deadwood_label_id = v_deadwood_label_id
    WHERE id = p_patch_id;
  END IF;

  -- Process FOREST COVER geometries
  IF v_forest_pred_label_id IS NOT NULL THEN
    -- Create reference label for forest cover
    INSERT INTO v2_labels (
      dataset_id,
      user_id,
      label_data,
      label_type,
      label_source,
      reference_patch_id,
      version,
      is_active
    ) VALUES (
      p_dataset_id,
      p_user_id,
      'forest_cover',
      'semantic_segmentation',
      'reference_patch',
      p_patch_id,
      1,
      true
    )
    RETURNING id INTO v_forest_cover_label_id;

    -- Copy and clip forest cover geometries
    WITH clipped_geoms AS (
      SELECT 
        v_forest_cover_label_id as label_id,
        p_patch_id as patch_id,
        ST_Intersection(
          ST_Transform(ST_GeomFromGeoJSON((geometry)::text), 3857),
          v_patch_geom
        ) as clipped_geom,
        ST_Area(
          ST_Intersection(
            ST_Transform(ST_GeomFromGeoJSON((geometry)::text), 3857),
            v_patch_geom
          )
        ) as area_m2
      FROM v2_forest_cover_geometries
      WHERE label_id = v_forest_pred_label_id
        AND ST_Intersects(
          ST_Transform(ST_GeomFromGeoJSON((geometry)::text), 3857),
          v_patch_geom
        )
    )
    INSERT INTO reference_patch_forest_cover_geometries (
      label_id,
      patch_id,
      geometry,
      area_m2
    )
    SELECT 
      label_id,
      patch_id,
      ST_AsGeoJSON(ST_Transform(clipped_geom, 4326))::jsonb as geometry,
      area_m2
    FROM clipped_geoms
    WHERE ST_GeometryType(clipped_geom) IN ('ST_Polygon', 'ST_MultiPolygon')
      AND area_m2 > 0.1; -- Filter out tiny slivers

    GET DIAGNOSTICS v_forest_count = ROW_COUNT;

    -- Update patch with reference label ID
    UPDATE reference_patches
    SET reference_forest_cover_label_id = v_forest_cover_label_id
    WHERE id = p_patch_id;
  END IF;

  -- Return summary
  RETURN QUERY SELECT 
    v_deadwood_label_id,
    v_deadwood_count,
    v_forest_cover_label_id,
    v_forest_count;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_clipped_geometries_for_patch(p_label_id bigint, p_geometry_table text, p_bbox_minx double precision, p_bbox_miny double precision, p_bbox_maxx double precision, p_bbox_maxy double precision, p_buffer_m double precision DEFAULT 2.0)
 RETURNS TABLE(geometry jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  bbox_geom GEOMETRY;
BEGIN
  -- Create bbox geometry in EPSG:3857 (Web Mercator, in meters) with buffer
  bbox_geom := ST_MakeEnvelope(
    p_bbox_minx - p_buffer_m,
    p_bbox_miny - p_buffer_m,
    p_bbox_maxx + p_buffer_m,
    p_bbox_maxy + p_buffer_m,
    3857
  );

  -- Transform bbox to EPSG:4326 for comparison with stored geometries
  bbox_geom := ST_Transform(bbox_geom, 4326);

  -- Query geometries, filter by spatial intersection, and clip them
  -- Use ST_MakeValid to fix any invalid geometries before clipping
  -- Use ST_CollectionExtract to handle geometry collections
  RETURN QUERY EXECUTE format(
    'SELECT 
      ST_AsGeoJSON(
        CASE 
          WHEN ST_GeometryType(clipped_geom) = ''ST_GeometryCollection'' 
          THEN ST_CollectionExtract(clipped_geom, 3)  -- Extract polygons from collection
          ELSE clipped_geom
        END
      )::jsonb as geometry
    FROM (
      SELECT 
        ST_Intersection(
          ST_MakeValid(geometry),  -- Fix invalid geometries
          $1
        ) as clipped_geom
      FROM %I
      WHERE label_id = $2
      AND ST_Intersects(geometry, $1)
    ) sub
    WHERE NOT ST_IsEmpty(clipped_geom)  -- Filter out empty results
    AND ST_GeometryType(clipped_geom) IN (''ST_Polygon'', ''ST_MultiPolygon'', ''ST_GeometryCollection'')',
    p_geometry_table
  ) USING bbox_geom, p_label_id;
END;
$function$
;

create or replace view "public"."dev_full_dataset_view" as  WITH ds AS (
         SELECT dev_datasets.id,
            dev_datasets.file_name,
            dev_datasets.file_size,
            dev_datasets.bbox,
            dev_datasets.status,
            dev_datasets.created_at,
            dev_datasets.copy_time,
            dev_datasets.sha256,
            dev_datasets.file_alias
           FROM dev_datasets
        ), extra AS (
         SELECT ds_1.id AS dataset_id,
            cog.cog_folder,
            cog.cog_name,
            cog.cog_url,
            lab.label_source,
            lab.label_quality,
            lab.label_type,
            thumb.base64img AS thumbnail_src
           FROM (((dev_datasets ds_1
             LEFT JOIN dev_cogs cog ON ((cog.dataset_id = ds_1.id)))
             LEFT JOIN v1_labels lab ON ((lab.dataset_id = ds_1.id)))
             LEFT JOIN dev_thumbnails thumb ON ((thumb.dataset_id = ds_1.id)))
        )
 SELECT ds.id,
    ds.file_name,
    ds.file_size,
    ds.bbox,
    ds.status,
    ds.created_at,
    ds.copy_time,
    ds.sha256,
    ds.file_alias,
    m.dataset_id,
    m.user_id,
    m.name,
    m.license,
    m.platform,
    m.project_id,
    m.authors,
    m.spectral_properties,
    m.citation_doi,
    m.admin_level_1,
    m.admin_level_2,
    m.admin_level_3,
    m.aquisition_day,
    m.aquisition_month,
    m.aquisition_year,
    m.additional_information,
    extra.cog_folder,
    extra.cog_name,
    extra.cog_url,
    extra.label_source,
    extra.label_quality,
    extra.label_type,
    extra.thumbnail_src
   FROM ((ds
     LEFT JOIN dev_metadata m ON ((m.dataset_id = ds.id)))
     LEFT JOIN extra ON ((extra.dataset_id = ds.id)));


create or replace view "public"."v1_full_dataset_view" as  WITH ds AS (
         SELECT v1_datasets.id,
            v1_datasets.file_name,
            v1_datasets.file_size,
            v1_datasets.bbox,
            v1_datasets.status,
            v1_datasets.created_at,
            v1_datasets.copy_time,
            v1_datasets.sha256,
            v1_datasets.file_alias
           FROM v1_datasets
        ), extra AS (
         SELECT ds_1.id AS dataset_id,
            cog.cog_folder,
            cog.cog_name,
            cog.cog_url,
            lab.label_source,
            lab.label_quality,
            lab.label_type,
            thumb.thumbnail_path
           FROM (((v1_datasets ds_1
             LEFT JOIN v1_cogs cog ON ((cog.dataset_id = ds_1.id)))
             LEFT JOIN v1_labels lab ON ((lab.dataset_id = ds_1.id)))
             LEFT JOIN v1_thumbnails thumb ON ((thumb.dataset_id = ds_1.id)))
        )
 SELECT ds.id,
    ds.file_name,
    ds.file_size,
    ds.bbox,
    ds.status,
    ds.created_at,
    ds.copy_time,
    ds.sha256,
    ds.file_alias,
    m.dataset_id,
    m.user_id,
    m.name,
    m.license,
    m.platform,
    m.project_id,
    m.authors,
    m.spectral_properties,
    m.citation_doi,
    m.admin_level_1,
    m.admin_level_2,
    m.admin_level_3,
    m.aquisition_day,
    m.aquisition_month,
    m.aquisition_year,
    m.additional_information,
    extra.cog_folder,
    extra.cog_name,
    extra.cog_url,
    extra.label_source,
    extra.label_quality,
    extra.label_type,
    extra.thumbnail_path
   FROM ((ds
     LEFT JOIN v1_metadata m ON ((m.dataset_id = ds.id)))
     LEFT JOIN extra ON ((extra.dataset_id = ds.id)));


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


grant delete on table "public"."reference_patch_deadwood_geometries" to "anon";

grant insert on table "public"."reference_patch_deadwood_geometries" to "anon";

grant references on table "public"."reference_patch_deadwood_geometries" to "anon";

grant select on table "public"."reference_patch_deadwood_geometries" to "anon";

grant trigger on table "public"."reference_patch_deadwood_geometries" to "anon";

grant truncate on table "public"."reference_patch_deadwood_geometries" to "anon";

grant update on table "public"."reference_patch_deadwood_geometries" to "anon";

grant delete on table "public"."reference_patch_deadwood_geometries" to "authenticated";

grant insert on table "public"."reference_patch_deadwood_geometries" to "authenticated";

grant references on table "public"."reference_patch_deadwood_geometries" to "authenticated";

grant select on table "public"."reference_patch_deadwood_geometries" to "authenticated";

grant trigger on table "public"."reference_patch_deadwood_geometries" to "authenticated";

grant truncate on table "public"."reference_patch_deadwood_geometries" to "authenticated";

grant update on table "public"."reference_patch_deadwood_geometries" to "authenticated";

grant delete on table "public"."reference_patch_deadwood_geometries" to "service_role";

grant insert on table "public"."reference_patch_deadwood_geometries" to "service_role";

grant references on table "public"."reference_patch_deadwood_geometries" to "service_role";

grant select on table "public"."reference_patch_deadwood_geometries" to "service_role";

grant trigger on table "public"."reference_patch_deadwood_geometries" to "service_role";

grant truncate on table "public"."reference_patch_deadwood_geometries" to "service_role";

grant update on table "public"."reference_patch_deadwood_geometries" to "service_role";

grant delete on table "public"."reference_patch_forest_cover_geometries" to "anon";

grant insert on table "public"."reference_patch_forest_cover_geometries" to "anon";

grant references on table "public"."reference_patch_forest_cover_geometries" to "anon";

grant select on table "public"."reference_patch_forest_cover_geometries" to "anon";

grant trigger on table "public"."reference_patch_forest_cover_geometries" to "anon";

grant truncate on table "public"."reference_patch_forest_cover_geometries" to "anon";

grant update on table "public"."reference_patch_forest_cover_geometries" to "anon";

grant delete on table "public"."reference_patch_forest_cover_geometries" to "authenticated";

grant insert on table "public"."reference_patch_forest_cover_geometries" to "authenticated";

grant references on table "public"."reference_patch_forest_cover_geometries" to "authenticated";

grant select on table "public"."reference_patch_forest_cover_geometries" to "authenticated";

grant trigger on table "public"."reference_patch_forest_cover_geometries" to "authenticated";

grant truncate on table "public"."reference_patch_forest_cover_geometries" to "authenticated";

grant update on table "public"."reference_patch_forest_cover_geometries" to "authenticated";

grant delete on table "public"."reference_patch_forest_cover_geometries" to "service_role";

grant insert on table "public"."reference_patch_forest_cover_geometries" to "service_role";

grant references on table "public"."reference_patch_forest_cover_geometries" to "service_role";

grant select on table "public"."reference_patch_forest_cover_geometries" to "service_role";

grant trigger on table "public"."reference_patch_forest_cover_geometries" to "service_role";

grant truncate on table "public"."reference_patch_forest_cover_geometries" to "service_role";

grant update on table "public"."reference_patch_forest_cover_geometries" to "service_role";

grant delete on table "public"."reference_patches" to "anon";

grant insert on table "public"."reference_patches" to "anon";

grant references on table "public"."reference_patches" to "anon";

grant select on table "public"."reference_patches" to "anon";

grant trigger on table "public"."reference_patches" to "anon";

grant truncate on table "public"."reference_patches" to "anon";

grant update on table "public"."reference_patches" to "anon";

grant delete on table "public"."reference_patches" to "authenticated";

grant insert on table "public"."reference_patches" to "authenticated";

grant references on table "public"."reference_patches" to "authenticated";

grant select on table "public"."reference_patches" to "authenticated";

grant trigger on table "public"."reference_patches" to "authenticated";

grant truncate on table "public"."reference_patches" to "authenticated";

grant update on table "public"."reference_patches" to "authenticated";

grant delete on table "public"."reference_patches" to "service_role";

grant insert on table "public"."reference_patches" to "service_role";

grant references on table "public"."reference_patches" to "service_role";

grant select on table "public"."reference_patches" to "service_role";

grant trigger on table "public"."reference_patches" to "service_role";

grant truncate on table "public"."reference_patches" to "service_role";

grant update on table "public"."reference_patches" to "service_role";

create policy "privileged_users_delete_deadwood_geoms"
on "public"."reference_patch_deadwood_geometries"
as permissive
for delete
to authenticated
using ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))));


create policy "privileged_users_insert_deadwood_geoms"
on "public"."reference_patch_deadwood_geometries"
as permissive
for insert
to authenticated
with check ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))));


create policy "privileged_users_select_deadwood_geoms"
on "public"."reference_patch_deadwood_geometries"
as permissive
for select
to authenticated
using ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))));


create policy "privileged_users_update_deadwood_geoms"
on "public"."reference_patch_deadwood_geometries"
as permissive
for update
to authenticated
using ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))))
with check ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))));


create policy "privileged_users_delete_forest_cover_geoms"
on "public"."reference_patch_forest_cover_geometries"
as permissive
for delete
to authenticated
using ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))));


create policy "privileged_users_insert_forest_cover_geoms"
on "public"."reference_patch_forest_cover_geometries"
as permissive
for insert
to authenticated
with check ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))));


create policy "privileged_users_select_forest_cover_geoms"
on "public"."reference_patch_forest_cover_geometries"
as permissive
for select
to authenticated
using ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))));


create policy "privileged_users_update_forest_cover_geoms"
on "public"."reference_patch_forest_cover_geometries"
as permissive
for update
to authenticated
using ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))))
with check ((EXISTS ( SELECT 1
   FROM privileged_users pu
  WHERE ((pu.user_id = auth.uid()) AND COALESCE(pu.can_audit, false)))));


create policy "Auditors can manage tiles"
on "public"."reference_patches"
as permissive
for all
to public
using ((auth.uid() IN ( SELECT privileged_users.user_id
   FROM privileged_users
  WHERE (privileged_users.can_audit = true))));


create policy "Auditors can view all tiles"
on "public"."reference_patches"
as permissive
for select
to public
using ((auth.uid() IN ( SELECT privileged_users.user_id
   FROM privileged_users
  WHERE (privileged_users.can_audit = true))));



