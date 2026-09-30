-- Status rows, processing logs and admin read models were open to every role.
--
-- * v2_statuses: any signed-in user could insert a status row for any dataset,
--   and nothing kept one row per dataset.
-- * v2_logs: anyone, without a login, could read every log line (private
--   dataset ids, file names, errors, user ids); any signed-in user could write
--   log lines for any dataset, which the factory metrics treat as evidence.
-- * v2_full_dataset_view showed excluded datasets and raw processor errors to
--   everyone, and v_export_polygon_candidates (every prediction polygon,
--   evaluated with the view owner's rights) was readable without a login.
-- * The remaining older SECURITY DEFINER functions had no pinned search_path.

-- Statuses ---------------------------------------------------------------------

-- Production holds exactly one row per dataset; keep it that way.
alter table public.v2_statuses
	add constraint v2_statuses_dataset_id_key unique (dataset_id);

revoke insert, update, delete, truncate on table public.v2_statuses from anon;

-- The processor, the dataset owner (upload) and auditors (reference-patch
-- session locks) create status rows.
drop policy if exists "Enable insert for authenticated users only" on public.v2_statuses;
create policy "Owners, auditors and the processor create status rows"
on public.v2_statuses for insert to authenticated
with check (
	(select auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
	or (select public.can_audit())
	or exists (
		select 1 from public.v2_datasets d
		where d.id = dataset_id and d.user_id = (select auth.uid())
	)
);

-- Queue inserts are already limited to owners and privileged users.
revoke insert, update, delete, truncate on table public.v2_queue from anon;

-- Logs ---------------------------------------------------------------------------

revoke insert, update, delete, truncate on table public.v2_logs from anon;
revoke update, truncate on table public.v2_logs from authenticated;

-- Readers: the processor (Linear failure issues), operators, and users for their
-- own rows (the API's daily download limit counts the caller's own lines).
drop policy if exists "Enable read access for all users" on public.v2_logs;
revoke select on table public.v2_logs from anon;
create policy "Processor, operators and owners read logs"
on public.v2_logs for select to authenticated
using (
	(select auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
	or (select public.can_operate())
	or user_id = (select auth.uid())
);

-- Writers: the processor, or a signed-in user writing their own lines about a
-- dataset they can see.
drop policy if exists "Enable insert for authenticated users only" on public.v2_logs;
create policy "Processor and users write their own logs"
on public.v2_logs for insert to authenticated
with check (
	(select auth.jwt() ->> 'email') = 'processor@deadtrees.earth'
	or (
		coalesce(user_id, (select auth.uid())) = (select auth.uid())
		and (dataset_id is null or public.is_dataset_search_visible(dataset_id))
	)
);

-- Admin read models ---------------------------------------------------------------

-- v2_full_dataset_view stays readable by anon because the public and owner views
-- are security-invoker views built on it. It now hides excluded datasets from
-- logged-out callers (as the public view does) and shows raw processor errors
-- only to the owner, privileged users and the processor.
-- Copied from 20260707200000_add_phenology_probability_to_dataset_view.sql; only
-- the ds filter and the error_message column change. security_invoker must be
-- restated because CREATE OR REPLACE resets view options.
CREATE OR REPLACE VIEW public.v2_full_dataset_view
WITH (security_invoker = true) AS
 WITH ds AS (
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
            v2_datasets.citation_doi,
            v2_datasets.archived
           FROM v2_datasets
          WHERE (v2_datasets.data_access <> 'private'::access OR auth.uid() = v2_datasets.user_id OR can_view_all_private_data()) AND (v2_datasets.archived = false OR auth.uid() = v2_datasets.user_id)
            AND (auth.uid() IS NOT NULL OR NOT internal.is_dataset_excluded_from_public_surface(v2_datasets.id))
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
            (EXISTS ( SELECT 1
                   FROM dataset_audit da
                  WHERE da.dataset_id = v2_statuses.dataset_id)) AS is_audited,
            v2_statuses.has_error,
            v2_statuses.error_message,
            v2_statuses.has_ml_tiles,
            v2_statuses.ml_tiles_completed_at,
            v2_statuses.is_combined_model_done,
            v2_statuses.is_aoi_done,
            v2_statuses.is_aoi_required
           FROM v2_statuses
        ), extra AS (
         SELECT ds_1.id AS dataset_id,
            cog.cog_file_name,
            cog.cog_path,
            cog.cog_file_size,
            thumb.thumbnail_file_name,
            thumb.thumbnail_path,
            meta.metadata ->> 'gadm'::text AS admin_metadata,
            meta.metadata ->> 'biome'::text AS biome_metadata,
            public.phenology_probability_at(meta.metadata -> 'phenology'::text -> 'phenology_curve'::text, ds_1.aquisition_year, ds_1.aquisition_month, ds_1.aquisition_day) AS phenology_probability
           FROM v2_datasets ds_1
             LEFT JOIN v2_cogs cog ON cog.dataset_id = ds_1.id
             LEFT JOIN v2_thumbnails thumb ON thumb.dataset_id = ds_1.id
             LEFT JOIN v2_metadata meta ON meta.dataset_id = ds_1.id
          WHERE (ds_1.data_access <> 'private'::access OR auth.uid() = ds_1.user_id OR can_view_all_private_data()) AND (ds_1.archived = false OR auth.uid() = ds_1.user_id)
        ), label_info AS (
         SELECT dataset.id AS dataset_id,
            (EXISTS ( SELECT 1
                   FROM v2_labels
                  WHERE v2_labels.dataset_id = dataset.id AND v2_labels.label_source = 'visual_interpretation'::"LabelSource" AND v2_labels.label_data = 'deadwood'::"LabelData")) AS has_labels,
            (EXISTS ( SELECT 1
                   FROM v2_labels
                  WHERE v2_labels.dataset_id = dataset.id AND v2_labels.label_source = 'model_prediction'::"LabelSource" AND v2_labels.label_data = 'deadwood'::"LabelData")) AS has_deadwood_prediction
           FROM v2_datasets dataset
          WHERE (dataset.data_access <> 'private'::access OR auth.uid() = dataset.user_id OR can_view_all_private_data()) AND (dataset.archived = false OR auth.uid() = dataset.user_id)
        ), freidata_doi AS (
         SELECT jt.dataset_id,
            dp.doi AS freidata_doi
           FROM jt_data_publication_datasets jt
             JOIN data_publication dp ON dp.id = jt.publication_id
          WHERE dp.doi IS NOT NULL
        ), correction_stats AS (
         SELECT gc.dataset_id,
            count(*) FILTER (WHERE gc.review_status = 'pending'::text) AS pending_corrections_count,
            count(*) FILTER (WHERE gc.review_status = 'approved'::text) AS approved_corrections_count,
            count(*) FILTER (WHERE gc.review_status = 'rejected'::text) AS rejected_corrections_count,
            count(*) AS total_corrections_count
           FROM v2_geometry_corrections gc
          GROUP BY gc.dataset_id
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
    ds.archived,
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
    CASE
        WHEN ds.user_id = auth.uid() OR can_view_all_private_data() OR can_audit()
            OR (auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text
        THEN status.error_message
    END AS error_message,
    extra.cog_file_name,
    extra.cog_path,
    extra.cog_file_size,
    extra.thumbnail_file_name,
    extra.thumbnail_path,
    extra.admin_metadata::jsonb ->> 'admin_level_1'::text AS admin_level_1,
    extra.admin_metadata::jsonb ->> 'admin_level_2'::text AS admin_level_2,
    extra.admin_metadata::jsonb ->> 'admin_level_3'::text AS admin_level_3,
    extra.biome_metadata::jsonb ->> 'biome_name'::text AS biome_name,
    label_info.has_labels,
    label_info.has_deadwood_prediction,
    freidata_doi.freidata_doi,
    status.has_ml_tiles,
    status.ml_tiles_completed_at,
    COALESCE(correction_stats.pending_corrections_count, 0::bigint) AS pending_corrections_count,
    COALESCE(correction_stats.approved_corrections_count, 0::bigint) AS approved_corrections_count,
    COALESCE(correction_stats.rejected_corrections_count, 0::bigint) AS rejected_corrections_count,
    COALESCE(correction_stats.total_corrections_count, 0::bigint) AS total_corrections_count,
    status.is_combined_model_done,
    status.is_aoi_done,
    status.is_aoi_required,
    extra.phenology_probability
   FROM ds
     LEFT JOIN ortho ON ortho.dataset_id = ds.id
     LEFT JOIN status ON status.dataset_id = ds.id
     LEFT JOIN extra ON extra.dataset_id = ds.id
     LEFT JOIN label_info ON label_info.dataset_id = ds.id
     LEFT JOIN freidata_doi ON freidata_doi.dataset_id = ds.id
     LEFT JOIN correction_stats ON correction_stats.dataset_id = ds.id;


-- Read only by the direct-database export script.
revoke all on table public.v_export_polygon_candidates from anon, authenticated;

-- Older definer functions ---------------------------------------------------------

alter function public.update_flag_status(bigint, text, text) set search_path = public, pg_temp;
alter function public.log_dataset_changes() set search_path = public, pg_temp;
alter function public.can_view_all_private_data() set search_path = public, pg_temp;

-- update_flag_status requires an auditor; log_dataset_changes is a trigger.
-- can_view_all_private_data stays executable by anon: RLS policies call it.
revoke all on function public.update_flag_status(bigint, text, text) from public, anon;
grant execute on function public.update_flag_status(bigint, text, text) to authenticated;
revoke all on function public.log_dataset_changes() from public, anon, authenticated;
