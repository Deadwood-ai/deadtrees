drop view if exists "public"."v2_full_dataset_view";

alter table "public"."v2_statuses" alter column "current_status" drop default;

alter type "public"."v2_status" rename to "v2_status__old_version_to_be_dropped";

create type "public"."v2_status" as enum ('idle', 'uploading', 'ortho_processing', 'cog_processing', 'thumbnail_processing', 'deadwood_segmentation', 'forest_cover_segmentation', 'audit_in_progress', 'metadata_processing', 'odm_processing');

create table "public"."v2_raw_images" (
    "dataset_id" bigint not null,
    "raw_image_count" integer not null,
    "raw_image_size_mb" integer not null,
    "raw_images_path" text not null,
    "camera_metadata" jsonb,
    "has_rtk_data" boolean not null default false,
    "rtk_precision_cm" numeric(4,2),
    "rtk_quality_indicator" integer,
    "rtk_file_count" integer default 0,
    "version" integer not null default 1,
    "created_at" timestamp with time zone not null default now()
);


alter table "public"."v2_raw_images" enable row level security;

alter table "public"."v2_statuses" alter column current_status type "public"."v2_status" using current_status::text::"public"."v2_status";

alter table "public"."v2_statuses" alter column "current_status" set default 'idle'::v2_status;

drop type "public"."v2_status__old_version_to_be_dropped";

alter table "public"."v2_statuses" add column "is_odm_done" boolean not null default false;

CREATE INDEX v2_raw_images_camera_metadata_gin_idx ON public.v2_raw_images USING gin (camera_metadata);

CREATE UNIQUE INDEX v2_raw_images_pkey ON public.v2_raw_images USING btree (dataset_id);

alter table "public"."v2_raw_images" add constraint "v2_raw_images_pkey" PRIMARY KEY using index "v2_raw_images_pkey";

alter table "public"."v2_raw_images" add constraint "v2_raw_images_dataset_id_fkey" FOREIGN KEY (dataset_id) REFERENCES v2_datasets(id) ON DELETE CASCADE not valid;

alter table "public"."v2_raw_images" validate constraint "v2_raw_images_dataset_id_fkey";

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
            v2_statuses.error_message
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
    freidata_doi.freidata_doi
   FROM (((((ds
     LEFT JOIN ortho ON ((ortho.dataset_id = ds.id)))
     LEFT JOIN status ON ((status.dataset_id = ds.id)))
     LEFT JOIN extra ON ((extra.dataset_id = ds.id)))
     LEFT JOIN label_info ON ((label_info.dataset_id = ds.id)))
     LEFT JOIN freidata_doi ON ((freidata_doi.dataset_id = ds.id)));


grant delete on table "public"."v2_raw_images" to "anon";

grant insert on table "public"."v2_raw_images" to "anon";

grant references on table "public"."v2_raw_images" to "anon";

grant select on table "public"."v2_raw_images" to "anon";

grant trigger on table "public"."v2_raw_images" to "anon";

grant truncate on table "public"."v2_raw_images" to "anon";

grant update on table "public"."v2_raw_images" to "anon";

grant delete on table "public"."v2_raw_images" to "authenticated";

grant insert on table "public"."v2_raw_images" to "authenticated";

grant references on table "public"."v2_raw_images" to "authenticated";

grant select on table "public"."v2_raw_images" to "authenticated";

grant trigger on table "public"."v2_raw_images" to "authenticated";

grant truncate on table "public"."v2_raw_images" to "authenticated";

grant update on table "public"."v2_raw_images" to "authenticated";

grant delete on table "public"."v2_raw_images" to "service_role";

grant insert on table "public"."v2_raw_images" to "service_role";

grant references on table "public"."v2_raw_images" to "service_role";

grant select on table "public"."v2_raw_images" to "service_role";

grant trigger on table "public"."v2_raw_images" to "service_role";

grant truncate on table "public"."v2_raw_images" to "service_role";

grant update on table "public"."v2_raw_images" to "service_role";


