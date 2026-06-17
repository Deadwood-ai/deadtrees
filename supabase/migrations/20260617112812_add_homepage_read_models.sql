create or replace view "public"."public_home_dataset_base" as
select
  id,
  authors,
  aquisition_year::smallint as aquisition_year,
  aquisition_month::smallint as aquisition_month,
  aquisition_day::smallint as aquisition_day,
  platform,
  thumbnail_path,
  admin_level_1,
  admin_level_2,
  admin_level_3,
  ortho_file_size,
  bbox
from v2_full_dataset_view_public
where is_cog_done = true
  and is_thumbnail_done = true
  and is_metadata_done = true
  and admin_level_1 is not null
  and (
    has_error = false
    or (is_deadwood_done = true and is_forest_cover_done = false)
  );

alter view public.public_home_dataset_base set (security_invoker = true);

grant select on table "public"."public_home_dataset_base" to "anon";
grant select on table "public"."public_home_dataset_base" to "authenticated";
grant select on table "public"."public_home_dataset_base" to "service_role";

create or replace view "public"."public_home_dataset_teasers" as
with ranked_author_teasers as (
  select
    base.id,
    base.authors,
    base.aquisition_year,
    base.aquisition_month,
    base.aquisition_day,
    base.platform,
    base.thumbnail_path,
    base.admin_level_1,
    base.admin_level_2,
    base.admin_level_3,
    row_number() over (
      partition by lower(nullif(trim(author), ''))
      order by base.id desc
    ) as author_rank
  from public_home_dataset_base base
  cross join lateral unnest(base.authors) as author
  where nullif(trim(author), '') is not null
    and base.thumbnail_path is not null
)
select distinct on (id)
  id,
  authors,
  aquisition_year,
  aquisition_month,
  aquisition_day,
  platform,
  thumbnail_path,
  admin_level_1,
  admin_level_2,
  admin_level_3
from ranked_author_teasers
where author_rank = 1
order by id;

alter view public.public_home_dataset_teasers set (security_invoker = true);

grant select on table "public"."public_home_dataset_teasers" to "anon";
grant select on table "public"."public_home_dataset_teasers" to "authenticated";
grant select on table "public"."public_home_dataset_teasers" to "service_role";

create or replace view "public"."public_home_stats" as
with bbox_parts as (
  select
    id,
    regexp_match(
      bbox::text,
      '^BOX\(([-+0-9.eE]+) ([-+0-9.eE]+),([-+0-9.eE]+) ([-+0-9.eE]+)\)$'
    ) as coords
  from public_home_dataset_base
),
contributors as (
  select distinct nullif(trim(author), '') as name
  from v2_full_dataset_view_public
  cross join lateral unnest(authors) as author
)
select
  (select count(*) from public_home_dataset_base)::bigint as dataset_count,
  (select count(distinct admin_level_1) from public_home_dataset_base)::bigint as country_count,
  (select count(*) from contributors where name is not null)::bigint as contributor_count,
  coalesce(
    (
      select sum(
        case
          when bp.coords is null then 0
          else abs(
            (((bp.coords)[4]::double precision - (bp.coords)[2]::double precision) * 111.32)
            * (((bp.coords)[3]::double precision - (bp.coords)[1]::double precision)
              * 111.32
              * cos(radians(((bp.coords)[2]::double precision + (bp.coords)[4]::double precision) / 2)))
            * 100
          )
        end
      )
      from bbox_parts bp
    ),
    0
  )::double precision as area_covered_ha,
  (
    select (coalesce(sum(ortho_file_size), 0) / 1048576.0)::double precision
    from public_home_dataset_base
  ) as data_size_tb,
  coalesce(
    (
      select array_agg(name order by name)
      from contributors
      where name is not null
    ),
    array[]::text[]
  ) as contributor_names;

alter view public.public_home_stats set (security_invoker = true);

grant select on table "public"."public_home_stats" to "anon";
grant select on table "public"."public_home_stats" to "authenticated";
grant select on table "public"."public_home_stats" to "service_role";
