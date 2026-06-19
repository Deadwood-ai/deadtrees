create or replace view "public"."public_home_dataset_base" as
select
  d.id,
  d.authors,
  d.aquisition_year::smallint as aquisition_year,
  d.aquisition_month::smallint as aquisition_month,
  d.aquisition_day::smallint as aquisition_day,
  d.platform,
  thumb.thumbnail_path,
  ((meta.metadata ->> 'gadm'::text)::jsonb ->> 'admin_level_1'::text) as admin_level_1,
  ((meta.metadata ->> 'gadm'::text)::jsonb ->> 'admin_level_2'::text) as admin_level_2,
  ((meta.metadata ->> 'gadm'::text)::jsonb ->> 'admin_level_3'::text) as admin_level_3,
  o.ortho_file_size,
  o.bbox
from v2_datasets d
join (
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
) s on s.dataset_id = d.id
join v2_orthos o on o.dataset_id = d.id
left join v2_thumbnails thumb on thumb.dataset_id = d.id
left join v2_metadata meta on meta.dataset_id = d.id
where d.data_access <> 'private'::access
  and d.archived = false
  and s.is_cog_done = true
  and s.is_thumbnail_done = true
  and s.is_metadata_done = true
  and ((meta.metadata ->> 'gadm'::text)::jsonb ->> 'admin_level_1'::text) is not null
  and (
    s.has_error = false
    or (s.is_deadwood_done = true and s.is_forest_cover_done = false)
  );

alter view public.public_home_dataset_base set (security_invoker = true);

grant select on table "public"."public_home_dataset_base" to "anon";
grant select on table "public"."public_home_dataset_base" to "authenticated";
grant select on table "public"."public_home_dataset_base" to "service_role";

create or replace view "public"."public_home_stats" as
with base as materialized (
  select
    authors,
    admin_level_1,
    ortho_file_size,
    bbox
  from public_home_dataset_base
),
dataset_stats as (
  select
    count(*)::bigint as dataset_count,
    count(distinct admin_level_1)::bigint as country_count,
    coalesce(
      sum(
        case
          when coords is null then 0
          else abs(
            (((coords)[4]::double precision - (coords)[2]::double precision) * 111.32)
            * (((coords)[3]::double precision - (coords)[1]::double precision)
              * 111.32
              * cos(radians(((coords)[2]::double precision + (coords)[4]::double precision) / 2)))
            * 100
          )
        end
      ),
      0
    )::double precision as area_covered_ha,
    (coalesce(sum(ortho_file_size), 0) / 1048576.0)::double precision as data_size_tb
  from (
    select
      bbox,
      admin_level_1,
      ortho_file_size,
      regexp_match(
        bbox::text,
        '^BOX\(([-+0-9.eE]+) ([-+0-9.eE]+),([-+0-9.eE]+) ([-+0-9.eE]+)\)$'
      ) as coords
    from base
  ) bbox_parts
),
contributor_stats as (
  select
    count(*)::bigint as contributor_count,
    array_agg(name order by name) as contributor_names
  from (
    select distinct nullif(trim(author), '') as name
    from base
    cross join lateral unnest(authors) as author
  ) contributors
  where name is not null
)
select
  dataset_stats.dataset_count,
  dataset_stats.country_count,
  contributor_stats.contributor_count,
  dataset_stats.area_covered_ha,
  dataset_stats.data_size_tb,
  coalesce(contributor_stats.contributor_names, array[]::text[]) as contributor_names
from dataset_stats
cross join contributor_stats;

alter view public.public_home_stats set (security_invoker = true);

grant select on table "public"."public_home_stats" to "anon";
grant select on table "public"."public_home_stats" to "authenticated";
grant select on table "public"."public_home_stats" to "service_role";
