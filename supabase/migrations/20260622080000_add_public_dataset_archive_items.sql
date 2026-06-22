drop view if exists "public"."public_dataset_archive_items";

create or replace view "public"."public_dataset_archive_items" as
with latest_status as (
  select distinct on (dataset_id)
    dataset_id,
    is_cog_done,
    is_thumbnail_done,
    is_deadwood_done,
    is_forest_cover_done,
    is_metadata_done,
    has_error
  from v2_statuses
  order by dataset_id, updated_at desc, id desc
),
archive_base as (
  select
    d.id,
    d.created_at,
    d.license,
    d.platform,
    d.authors,
    d.aquisition_year,
    d.aquisition_month,
    d.aquisition_day,
    o.bbox,
    thumb.thumbnail_path,
    ((meta.metadata ->> 'gadm'::text)::jsonb ->> 'admin_level_1'::text) as admin_level_1,
    ((meta.metadata ->> 'gadm'::text)::jsonb ->> 'admin_level_2'::text) as admin_level_2,
    ((meta.metadata ->> 'gadm'::text)::jsonb ->> 'admin_level_3'::text) as admin_level_3,
    ((meta.metadata ->> 'biome'::text)::jsonb ->> 'biome_name'::text) as biome_name,
    s.is_cog_done,
    s.is_thumbnail_done,
    s.is_metadata_done,
    s.has_error,
    s.is_deadwood_done,
    s.is_forest_cover_done
  from v2_datasets d
  join latest_status s on s.dataset_id = d.id
  join v2_orthos o on o.dataset_id = d.id
  left join v2_thumbnails thumb on thumb.dataset_id = d.id
  left join v2_metadata meta on meta.dataset_id = d.id
  where d.data_access <> 'private'::access
    and d.archived = false
),
label_info as (
  select
    dataset.id as dataset_id,
    exists (
      select 1
      from v2_labels
      where v2_labels.dataset_id = dataset.id
        and v2_labels.label_source = 'visual_interpretation'::"LabelSource"
        and v2_labels.label_data = 'deadwood'::"LabelData"
    ) as has_labels,
    exists (
      select 1
      from v2_labels
      where v2_labels.dataset_id = dataset.id
        and v2_labels.label_source = 'model_prediction'::"LabelSource"
        and v2_labels.label_data = 'deadwood'::"LabelData"
    ) as has_deadwood_prediction
  from v2_datasets dataset
  where dataset.data_access <> 'private'::access
    and dataset.archived = false
),
audit_data as (
  select
    da.dataset_id,
    da.final_assessment
  from dataset_audit da
)
select
  base.id,
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
  coalesce(label_info.has_labels, false) as has_labels,
  coalesce(label_info.has_deadwood_prediction, false) as has_deadwood_prediction
from archive_base base
left join label_info on label_info.dataset_id = base.id
left join audit_data on audit_data.dataset_id = base.id
where base.is_cog_done = true
  and base.is_thumbnail_done = true
  and base.is_metadata_done = true
  and base.admin_level_1 is not null
  and (
    base.has_error = false
    or (base.is_deadwood_done = true and base.is_forest_cover_done = false)
  )
  and (
    audit_data.final_assessment is null
    or audit_data.final_assessment <> 'exclude_completely'::text
  );

alter view public.public_dataset_archive_items set (security_invoker = true);

grant select on table "public"."public_dataset_archive_items" to "anon";
grant select on table "public"."public_dataset_archive_items" to "authenticated";
grant select on table "public"."public_dataset_archive_items" to "service_role";
