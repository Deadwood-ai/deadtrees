create sequence "public"."v2_dataset_edit_history_id_seq";

drop policy "Enable update for users based on email" on "public"."v2_datasets";

drop view if exists "public"."dev_full_dataset_view";

drop view if exists "public"."metadata_dev_egu_view";

drop view if exists "public"."v1_full_dataset_view";

drop view if exists "public"."v2_full_dataset_view";

drop view if exists "public"."dataset_audit_user_info";

drop view if exists "public"."data_publication_full_info";

alter type "public"."Platform" rename to "Platform__old_version_to_be_dropped";

create type "public"."Platform" as enum ('drone', 'airborne', 'satellite');

create table "public"."v2_dataset_edit_history" (
    "id" bigint not null default nextval('v2_dataset_edit_history_id_seq'::regclass),
    "dataset_id" bigint not null,
    "user_id" uuid not null,
    "changed_at" timestamp with time zone not null default now(),
    "field_name" text not null,
    "old_value" jsonb,
    "new_value" jsonb,
    "change_type" text not null default 'UPDATE'::text
);


alter table "public"."v2_dataset_edit_history" enable row level security;

alter table "public"."dev_metadata" alter column platform type "public"."Platform" using platform::text::"public"."Platform";

alter table "public"."upload_files_dev" alter column platform type "public"."Platform" using platform::text::"public"."Platform";

alter table "public"."v1_metadata" alter column platform type "public"."Platform" using platform::text::"public"."Platform";

alter table "public"."v2_datasets" alter column platform type "public"."Platform" using platform::text::"public"."Platform";

drop type "public"."Platform__old_version_to_be_dropped";

alter sequence "public"."v2_dataset_edit_history_id_seq" owned by "public"."v2_dataset_edit_history"."id";

CREATE UNIQUE INDEX v2_dataset_edit_history_pkey ON public.v2_dataset_edit_history USING btree (id);

alter table "public"."v2_dataset_edit_history" add constraint "v2_dataset_edit_history_pkey" PRIMARY KEY using index "v2_dataset_edit_history_pkey";

alter table "public"."v2_dataset_edit_history" add constraint "v2_dataset_edit_history_dataset_id_fkey" FOREIGN KEY (dataset_id) REFERENCES v2_datasets(id) ON DELETE CASCADE not valid;

alter table "public"."v2_dataset_edit_history" validate constraint "v2_dataset_edit_history_dataset_id_fkey";

alter table "public"."v2_dataset_edit_history" add constraint "v2_dataset_edit_history_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) not valid;

alter table "public"."v2_dataset_edit_history" validate constraint "v2_dataset_edit_history_user_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.log_dataset_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  current_user_id uuid;
BEGIN
  -- Get the current user ID, handling both regular users and processor
  IF (auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text THEN
    -- For processor user, we need to get the user_id from auth.users table
    SELECT id INTO current_user_id 
    FROM auth.users 
    WHERE email = 'processor@deadtrees.earth';
  ELSE
    -- For regular authenticated users
    current_user_id := auth.uid();
  END IF;

  -- Only log changes if we have a valid user_id
  IF current_user_id IS NOT NULL THEN
    -- Log each changed field
    IF OLD.authors IS DISTINCT FROM NEW.authors THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'authors', to_jsonb(OLD.authors), to_jsonb(NEW.authors));
    END IF;
    
    IF OLD.aquisition_year IS DISTINCT FROM NEW.aquisition_year THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'aquisition_year', to_jsonb(OLD.aquisition_year), to_jsonb(NEW.aquisition_year));
    END IF;
    
    IF OLD.aquisition_month IS DISTINCT FROM NEW.aquisition_month THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'aquisition_month', to_jsonb(OLD.aquisition_month), to_jsonb(NEW.aquisition_month));
    END IF;
    
    IF OLD.aquisition_day IS DISTINCT FROM NEW.aquisition_day THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'aquisition_day', to_jsonb(OLD.aquisition_day), to_jsonb(NEW.aquisition_day));
    END IF;
    
    IF OLD.platform IS DISTINCT FROM NEW.platform THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'platform', to_jsonb(OLD.platform), to_jsonb(NEW.platform));
    END IF;
    
    IF OLD.citation_doi IS DISTINCT FROM NEW.citation_doi THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'citation_doi', to_jsonb(OLD.citation_doi), to_jsonb(NEW.citation_doi));
    END IF;
    
    IF OLD.additional_information IS DISTINCT FROM NEW.additional_information THEN
      INSERT INTO public.v2_dataset_edit_history (dataset_id, user_id, field_name, old_value, new_value)
      VALUES (NEW.id, current_user_id, 'additional_information', to_jsonb(OLD.additional_information), to_jsonb(NEW.additional_information));
    END IF;
  END IF;
  
  RETURN NEW;
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


create or replace view "public"."dataset_audit_user_info" as  SELECT da.dataset_id,
    da.audit_date,
    da.is_georeferenced,
    da.has_valid_acquisition_date,
    da.acquisition_date_notes,
    da.has_valid_phenology,
    da.phenology_notes,
    da.deadwood_quality,
    da.deadwood_notes,
    da.forest_cover_quality,
    da.forest_cover_notes,
    da.aoi_done,
    da.has_cog_issue,
    da.cog_issue_notes,
    da.has_thumbnail_issue,
    da.thumbnail_issue_notes,
    da.audited_by,
    da.notes,
    da.has_major_issue,
    da.final_assessment,
    au.email AS audited_by_email,
    uu.email AS uploaded_by_email
   FROM (((dataset_audit da
     LEFT JOIN auth.users au ON ((da.audited_by = au.id)))
     LEFT JOIN v2_datasets d ON ((da.dataset_id = d.id)))
     LEFT JOIN auth.users uu ON ((d.user_id = uu.id)));

create or replace view "public"."data_publication_full_info" as  WITH datasets_by_publication AS (
         SELECT jp.publication_id,
            jsonb_agg(jsonb_build_object('dataset_id', ds.id, 'file_name', ds.file_name, 'license', ds.license, 'platform', ds.platform, 'authors', ds.authors, 'citation_doi', ds.citation_doi, 'aquisition_year', ds.aquisition_year, 'aquisition_month', ds.aquisition_month, 'aquisition_day', ds.aquisition_day, 'data_access', ds.data_access)) AS datasets
           FROM (jt_data_publication_datasets jp
             JOIN v2_datasets ds ON ((jp.dataset_id = ds.id)))
          GROUP BY jp.publication_id
        ), authors_by_publication AS (
         SELECT jp.publication_id,
            jsonb_agg(jsonb_build_object('author_id', ui.id, 'first_name', ui.first_name, 'last_name', ui.last_name, 'title', ui.title, 'organisation', ui.organisation, 'orcid', ui.orcid) ORDER BY ui.last_name, ui.first_name) AS authors,
            string_agg((((
                CASE
                    WHEN (ui.title IS NOT NULL) THEN (ui.title || ' '::text)
                    ELSE ''::text
                END || ui.first_name) || ' '::text) || ui.last_name), ', '::text ORDER BY ui.last_name, ui.first_name) AS author_display_names
           FROM (jt_data_publication_user_info jp
             JOIN user_info ui ON ((jp.user_info_id = ui.id)))
          GROUP BY jp.publication_id
        ), dataset_counts AS (
         SELECT jt_data_publication_datasets.publication_id,
            count(*) AS dataset_count
           FROM jt_data_publication_datasets
          GROUP BY jt_data_publication_datasets.publication_id
        )
 SELECT p.id AS publication_id,
    p.created_at,
    p.doi,
    p.title,
    p.description,
    p.user_id AS creator_user_id,
    a.authors,
    a.author_display_names,
    d.datasets,
    dc.dataset_count,
        CASE
            WHEN (p.doi IS NOT NULL) THEN true
            ELSE false
        END AS is_published
   FROM (((data_publication p
     LEFT JOIN datasets_by_publication d ON ((p.id = d.publication_id)))
     LEFT JOIN authors_by_publication a ON ((p.id = a.publication_id)))
     LEFT JOIN dataset_counts dc ON ((p.id = dc.publication_id)));


grant delete on table "public"."v2_dataset_edit_history" to "anon";

grant insert on table "public"."v2_dataset_edit_history" to "anon";

grant references on table "public"."v2_dataset_edit_history" to "anon";

grant select on table "public"."v2_dataset_edit_history" to "anon";

grant trigger on table "public"."v2_dataset_edit_history" to "anon";

grant truncate on table "public"."v2_dataset_edit_history" to "anon";

grant update on table "public"."v2_dataset_edit_history" to "anon";

grant delete on table "public"."v2_dataset_edit_history" to "authenticated";

grant insert on table "public"."v2_dataset_edit_history" to "authenticated";

grant references on table "public"."v2_dataset_edit_history" to "authenticated";

grant select on table "public"."v2_dataset_edit_history" to "authenticated";

grant trigger on table "public"."v2_dataset_edit_history" to "authenticated";

grant truncate on table "public"."v2_dataset_edit_history" to "authenticated";

grant update on table "public"."v2_dataset_edit_history" to "authenticated";

grant delete on table "public"."v2_dataset_edit_history" to "service_role";

grant insert on table "public"."v2_dataset_edit_history" to "service_role";

grant references on table "public"."v2_dataset_edit_history" to "service_role";

grant select on table "public"."v2_dataset_edit_history" to "service_role";

grant trigger on table "public"."v2_dataset_edit_history" to "service_role";

grant truncate on table "public"."v2_dataset_edit_history" to "service_role";

grant update on table "public"."v2_dataset_edit_history" to "service_role";

create policy "Enable insert for authenticated users"
on "public"."v2_dataset_edit_history"
as permissive
for insert
to authenticated
with check ((auth.uid() = user_id));


create policy "Enable read for dataset owners and admins"
on "public"."v2_dataset_edit_history"
as permissive
for select
to public
using (((auth.uid() IN ( SELECT v2_datasets.user_id
   FROM v2_datasets
  WHERE (v2_datasets.id = v2_dataset_edit_history.dataset_id))) OR can_view_all_private_data()));


create policy "Enable update for processor and owner"
on "public"."v2_datasets"
as permissive
for update
to public
using ((((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text) OR (auth.uid() = user_id)))
with check ((((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text) OR (auth.uid() = user_id)));


CREATE TRIGGER dataset_changes_audit_trigger AFTER UPDATE ON public.v2_datasets FOR EACH ROW EXECUTE FUNCTION log_dataset_changes();


