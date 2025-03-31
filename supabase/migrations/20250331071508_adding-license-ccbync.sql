drop view if exists "public"."dev_full_dataset_view";

drop view if exists "public"."metadata_dev_egu_view";

drop view if exists "public"."v1_full_dataset_view";

drop view if exists "public"."v2_full_dataset_view";

alter table "public"."upload_files_dev" alter column "license" drop default;

alter type "public"."License" rename to "License__old_version_to_be_dropped";

create type "public"."License" as enum ('CC BY', 'CC BY-SA', 'CC BY-NC-SA', 'MIT', 'CC BY-NC');

alter table "public"."dev_metadata" alter column license type "public"."License" using license::text::"public"."License";

alter table "public"."upload_files_dev" alter column license type "public"."License" using license::text::"public"."License";

alter table "public"."v1_metadata" alter column license type "public"."License" using license::text::"public"."License";

alter table "public"."v2_datasets" alter column license type "public"."License" using license::text::"public"."License";

alter table "public"."upload_files_dev" alter column "license" set default 'CC BY'::"License";

drop type "public"."License__old_version_to_be_dropped";

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


create or replace view "public"."metadata_dev_egu_view" as  SELECT upload_files_dev.id,
    upload_files_dev.uuid,
    upload_files_dev.user_id,
    upload_files_dev.aquisition_date,
    upload_files_dev.license,
    upload_files_dev.platform,
    upload_files_dev.status,
    upload_files_dev.wms_source,
    upload_files_dev.bbox,
    upload_files_dev.file_id,
    upload_files_dev.file_name,
    upload_files_dev.file_size,
    metadata_dev_egu.project_id,
    metadata_dev_egu.authors_image,
    metadata_dev_egu.label_type,
    metadata_dev_egu.label_source,
    metadata_dev_egu.image_spectral_properties,
    metadata_dev_egu.citation_doi,
    metadata_dev_egu.label_quality,
    metadata_dev_egu.has_labels,
    metadata_dev_egu.public,
    metadata_dev_egu.display_filename,
    metadata_dev_egu."gadm_NAME_0",
    metadata_dev_egu."gadm_NAME_1",
    metadata_dev_egu."gadm_NAME_2",
    metadata_dev_egu."gadm_NAME_3"
   FROM ((upload_files_dev
     LEFT JOIN labels_dev_egu ON ((upload_files_dev.file_name = labels_dev_egu.ortho_file_name)))
     LEFT JOIN metadata_dev_egu ON ((upload_files_dev.file_name = metadata_dev_egu.filename)));


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
    ((extra.biome_metadata)::jsonb ->> 'biome_name'::text) AS biome_name
   FROM (((ds
     LEFT JOIN ortho ON ((ortho.dataset_id = ds.id)))
     LEFT JOIN status ON ((status.dataset_id = ds.id)))
     LEFT JOIN extra ON ((extra.dataset_id = ds.id)));



