-- Aggregate the same ready, non-excluded datasets the current viewer can browse.
-- The security-invoker archive view owns visibility, including permitted private data.
create or replace view "public"."public_home_stats" as
with base as materialized (
  select
    archive.authors,
    archive.admin_level_1,
    ortho.ortho_file_size,
    archive.bbox
  from public.public_dataset_archive_items archive
  join public.v2_orthos ortho on ortho.dataset_id = archive.id
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
