-- Expose automatic AOI processing completion through dataset read models.
create or replace view "public"."v2_full_dataset_view" as
with ds as (
    select
        v2_datasets.id,
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
    from v2_datasets
    where (
        (v2_datasets.data_access <> 'private'::access)
        or (auth.uid() = v2_datasets.user_id)
        or can_view_all_private_data()
    )
    and (
        v2_datasets.archived = false
        or auth.uid() = v2_datasets.user_id
    )
), ortho as (
    select
        v2_orthos.dataset_id,
        v2_orthos.ortho_file_name,
        v2_orthos.ortho_file_size,
        v2_orthos.bbox,
        v2_orthos.sha256,
        v2_orthos.ortho_upload_runtime
    from v2_orthos
), status as (
    select
        v2_statuses.dataset_id,
        v2_statuses.current_status,
        v2_statuses.is_upload_done,
        v2_statuses.is_ortho_done,
        v2_statuses.is_cog_done,
        v2_statuses.is_thumbnail_done,
        v2_statuses.is_deadwood_done,
        v2_statuses.is_forest_cover_done,
        v2_statuses.is_metadata_done,
        v2_statuses.is_odm_done,
        (
            exists (
                select 1
                from dataset_audit da
                where da.dataset_id = v2_statuses.dataset_id
            )
        ) as is_audited,
        v2_statuses.has_error,
        v2_statuses.error_message,
        v2_statuses.has_ml_tiles,
        v2_statuses.ml_tiles_completed_at,
        v2_statuses.is_combined_model_done,
        v2_statuses.is_aoi_done
    from v2_statuses
), extra as (
    select
        ds_1.id as dataset_id,
        cog.cog_file_name,
        cog.cog_path,
        cog.cog_file_size,
        thumb.thumbnail_file_name,
        thumb.thumbnail_path,
        (meta.metadata ->> 'gadm'::text) as admin_metadata,
        (meta.metadata ->> 'biome'::text) as biome_metadata
    from v2_datasets ds_1
    left join v2_cogs cog on cog.dataset_id = ds_1.id
    left join v2_thumbnails thumb on thumb.dataset_id = ds_1.id
    left join v2_metadata meta on meta.dataset_id = ds_1.id
    where (
        (ds_1.data_access <> 'private'::access)
        or (auth.uid() = ds_1.user_id)
        or can_view_all_private_data()
    )
    and (
        ds_1.archived = false
        or auth.uid() = ds_1.user_id
    )
), label_info as (
    select
        dataset.id as dataset_id,
        (
            exists (
                select 1
                from v2_labels
                where v2_labels.dataset_id = dataset.id
                    and v2_labels.label_source = 'visual_interpretation'::"LabelSource"
                    and v2_labels.label_data = 'deadwood'::"LabelData"
            )
        ) as has_labels,
        (
            exists (
                select 1
                from v2_labels
                where v2_labels.dataset_id = dataset.id
                    and v2_labels.label_source = 'model_prediction'::"LabelSource"
                    and v2_labels.label_data = 'deadwood'::"LabelData"
            )
        ) as has_deadwood_prediction
    from v2_datasets dataset
    where (
        (dataset.data_access <> 'private'::access)
        or (auth.uid() = dataset.user_id)
        or can_view_all_private_data()
    )
    and (
        dataset.archived = false
        or auth.uid() = dataset.user_id
    )
), freidata_doi as (
    select
        jt.dataset_id,
        dp.doi as freidata_doi
    from jt_data_publication_datasets jt
    join data_publication dp on dp.id = jt.publication_id
    where dp.doi is not null
), correction_stats as (
    select
        gc.dataset_id,
        count(*) filter (where gc.review_status = 'pending'::text) as pending_corrections_count,
        count(*) filter (where gc.review_status = 'approved'::text) as approved_corrections_count,
        count(*) filter (where gc.review_status = 'rejected'::text) as rejected_corrections_count,
        count(*) as total_corrections_count
    from v2_geometry_corrections gc
    group by gc.dataset_id
)
select
    ds.id,
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
    status.error_message,
    extra.cog_file_name,
    extra.cog_path,
    extra.cog_file_size,
    extra.thumbnail_file_name,
    extra.thumbnail_path,
    ((extra.admin_metadata)::jsonb ->> 'admin_level_1'::text) as admin_level_1,
    ((extra.admin_metadata)::jsonb ->> 'admin_level_2'::text) as admin_level_2,
    ((extra.admin_metadata)::jsonb ->> 'admin_level_3'::text) as admin_level_3,
    ((extra.biome_metadata)::jsonb ->> 'biome_name'::text) as biome_name,
    label_info.has_labels,
    label_info.has_deadwood_prediction,
    freidata_doi.freidata_doi,
    status.has_ml_tiles,
    status.ml_tiles_completed_at,
    coalesce(correction_stats.pending_corrections_count, 0::bigint) as pending_corrections_count,
    coalesce(correction_stats.approved_corrections_count, 0::bigint) as approved_corrections_count,
    coalesce(correction_stats.rejected_corrections_count, 0::bigint) as rejected_corrections_count,
    coalesce(correction_stats.total_corrections_count, 0::bigint) as total_corrections_count,
    status.is_combined_model_done,
    status.is_aoi_done
from ds
left join ortho on ortho.dataset_id = ds.id
left join status on status.dataset_id = ds.id
left join extra on extra.dataset_id = ds.id
left join label_info on label_info.dataset_id = ds.id
left join freidata_doi on freidata_doi.dataset_id = ds.id
left join correction_stats on correction_stats.dataset_id = ds.id;

alter view public.v2_full_dataset_view set (security_invoker = true);

create or replace view "public"."v2_full_dataset_view_public" as
select
  base.id,
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
  base.archived,
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
  base.pending_corrections_count,
  base.approved_corrections_count,
  base.rejected_corrections_count,
  base.total_corrections_count,
  audit_data.final_assessment,
  audit_data.deadwood_quality,
  audit_data.forest_cover_quality,
  audit_data.has_major_issue,
  audit_data.audit_date,
  audit_data.has_valid_phenology,
  audit_data.has_valid_acquisition_date,
  case
    when audit_data.deadwood_quality in ('great', 'sentinel_ok') then true
    else false
  end as show_deadwood_predictions,
  case
    when audit_data.forest_cover_quality in ('great', 'sentinel_ok') then true
    else false
  end as show_forest_cover_predictions,
  base.is_combined_model_done,
  base.is_aoi_done
from v2_full_dataset_view base
left join (
  select
    da.dataset_id,
    da.final_assessment,
    da.deadwood_quality::text,
    da.forest_cover_quality::text,
    da.has_major_issue,
    da.audit_date,
    da.has_valid_phenology,
    da.has_valid_acquisition_date
  from dataset_audit da
) audit_data on audit_data.dataset_id = base.id
where (
  (audit_data.final_assessment is null)
  or (audit_data.final_assessment <> 'exclude_completely'::text)
)
and base.archived = false;

alter view public.v2_full_dataset_view_public set (security_invoker = true);

grant select on table "public"."v2_full_dataset_view_public" to "anon";
grant select on table "public"."v2_full_dataset_view_public" to "authenticated";
grant select on table "public"."v2_full_dataset_view_public" to "service_role";

create or replace view "public"."v2_processing_overview" as
select distinct on (d.id)
    d.id as dataset_id,
    d.file_name,
    d.created_at as dataset_created_at,
    case
        when ((coalesce(ri.raw_image_count, 0) > 0) or s.is_odm_done) then 'odm'::text
        else 'geotiff'::text
    end as processing_source,
    case
        when ((s.current_status <> 'idle'::v2_status) and (s.has_error is distinct from true)) then 'PROCESSING'::text
        when (exists (select 1 from v2_queue q where q.dataset_id = d.id)) then 'QUEUED'::text
        when s.has_error then 'FAILED'::text
        else 'COMPLETED'::text
    end as processing_status,
    s.current_status,
    s.has_error,
    s.error_message,
    (extract(epoch from (now() - s.updated_at)) / 3600::numeric) as hours_since_status_update,
    case
        when (s.current_status <> 'idle'::v2_status) then (extract(epoch from (now() - s.updated_at)) / 3600::numeric)
        else null::numeric
    end as hours_in_current_status,
    s.updated_at as status_last_updated,
    exists (select 1 from v2_queue q where q.dataset_id = d.id) as is_in_queue,
    (select min(q.created_at) from v2_queue q where q.dataset_id = d.id) as queued_at,
    (select min(q.priority) from v2_queue q where q.dataset_id = d.id) as queue_priority,
    au.email as user_email,
    ui.organisation,
    s.is_upload_done,
    s.is_ortho_done,
    s.is_cog_done,
    s.is_thumbnail_done,
    s.is_deadwood_done,
    s.is_forest_cover_done,
    s.is_metadata_done,
    s.is_odm_done,
    exists (select 1 from dataset_audit da where da.dataset_id = d.id) as is_audited,
    (select count(*) from v2_aois a where a.dataset_id = d.id) as aoi_count,
    (
        select count(dg.id)
        from v2_labels l
        left join v2_deadwood_geometries dg on dg.label_id = l.id
        where l.dataset_id = d.id
    ) as deadwood_geometry_count,
    (
        select count(fg.id)
        from v2_labels l
        left join v2_forest_cover_geometries fg on fg.label_id = l.id
        where l.dataset_id = d.id
    ) as forest_cover_geometry_count,
    ri.raw_images_path,
    ri.raw_image_count,
    ri.raw_image_size_mb,
    o.ortho_file_size,
    c.cog_file_size,
    coalesce(((o.ortho_info -> 'Profile'::text) ->> 'Width'::text)::integer, (o.ortho_info ->> 'Width'::text)::integer) as ortho_width,
    coalesce(((o.ortho_info -> 'Profile'::text) ->> 'Height'::text)::integer, (o.ortho_info ->> 'Height'::text)::integer) as ortho_height,
    ((o.ortho_info -> 'GEO'::text) ->> 'CRS'::text) as ortho_crs,
    ((c.cog_info -> 'GEO'::text) ->> 'CRS'::text) as cog_crs,
    jsonb_strip_nulls((coalesce(ri.camera_metadata, '{}'::jsonb) || jsonb_build_object('has_rtk_data', ri.has_rtk_data, 'rtk_precision_cm', ri.rtk_precision_cm, 'rtk_quality_indicator', ri.rtk_quality_indicator, 'rtk_file_count', ri.rtk_file_count))) as raw_images_metadata,
    o.ortho_info as ortho_metadata,
    c.cog_info as cog_metadata,
    (
        select string_agg(((((((recent_logs.level || '|'::text) || coalesce(recent_logs.category, 'general'::text)) || '|'::text) || to_char(recent_logs.created_at, 'MM-DD HH24:MI'::text)) || '|'::text) || substring(recent_logs.message, 1, 100)), chr(10) order by recent_logs.created_at desc)
        from (
            select v2_logs.level, v2_logs.category, v2_logs.message, v2_logs.created_at
            from v2_logs
            where v2_logs.dataset_id = d.id
            order by v2_logs.created_at desc
            limit 20
        ) recent_logs
    ) as last_20_logs,
    s.is_combined_model_done,
    s.is_aoi_done
from v2_datasets d
left join v2_statuses s on s.dataset_id = d.id
left join auth.users au on au.id = d.user_id
left join user_info ui on ui."user" = d.user_id
left join lateral (
    select o_1.dataset_id, o_1.ortho_file_name, o_1.version, o_1.created_at, o_1.bbox, o_1.sha256, o_1.ortho_upload_runtime, o_1.ortho_file_size, o_1.ortho_info
    from v2_orthos o_1
    where o_1.dataset_id = d.id
    order by o_1.created_at desc, o_1.version desc
    limit 1
) o on true
left join lateral (
    select c_1.dataset_id, c_1.cog_file_name, c_1.version, c_1.created_at, c_1.cog_info, c_1.cog_processing_runtime, c_1.cog_path, c_1.cog_file_size
    from v2_cogs c_1
    where c_1.dataset_id = d.id
    order by c_1.created_at desc, c_1.version desc
    limit 1
) c on true
left join lateral (
    select ri_1.dataset_id, ri_1.raw_image_count, ri_1.raw_image_size_mb, ri_1.raw_images_path, ri_1.camera_metadata, ri_1.has_rtk_data, ri_1.rtk_precision_cm, ri_1.rtk_quality_indicator, ri_1.rtk_file_count, ri_1.version, ri_1.created_at
    from v2_raw_images ri_1
    where ri_1.dataset_id = d.id
    order by ri_1.created_at desc, ri_1.version desc
    limit 1
) ri on true
order by d.id desc, coalesce(s.updated_at, d.created_at) desc
limit 100;

alter view public.v2_processing_overview set (security_invoker = true);
