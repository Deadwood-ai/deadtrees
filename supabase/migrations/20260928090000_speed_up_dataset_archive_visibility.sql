-- Make the /dataset archive feed cheap for API callers.
--
-- public_dataset_archive_items is security_invoker, so every row pays for the
-- caller's RLS. Two per-row costs dominated (~1 s for anon at 13.5k datasets,
-- 3.5 s mean for authenticated users in production, where the 3 s / 8 s role
-- statement timeouts turned it into HTTP 500s and an archive stuck loading):
--   * internal.is_dataset_excluded_from_public_surface(id): a SECURITY DEFINER
--     function the planner cannot inline, called once per archive row and once
--     per candidate label row through the v2_labels policy;
--   * auth.uid() / can_view_all_private_data() re-evaluated for every row.
--
-- Resolve both once per query instead: the caller's excluded datasets become a
-- hashed NOT IN, and the caller helpers become initPlans via (select ...).
-- Visibility is unchanged; api/tests/db/test_dataset_archive_visibility.py pins
-- both the per-caller results and the set-based plan shape.
BEGIN;

-- Set-based equivalent of internal.is_dataset_excluded_from_public_surface(id):
-- `id in (select internal.public_surface_excluded_dataset_ids())` holds exactly
-- when that function returns true for the current caller. Keep the predicates in
-- sync (20260615120000_restrict_raw_label_select_policy.sql).
create function internal.public_surface_excluded_dataset_ids()
returns setof bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
	select dataset.id
	from public.v2_datasets dataset
	where dataset.id in (
			select audit.dataset_id
			from public.dataset_audit audit
			where audit.final_assessment = 'exclude_completely'
		)
		and (
			dataset.data_access <> 'private'::access
			or dataset.user_id = (select auth.uid())
			or (select public.can_view_all_private_data())
		)
		and (
			dataset.archived = false
			or dataset.user_id = (select auth.uid())
		);
$$;

revoke all on function internal.public_surface_excluded_dataset_ids() from public;
grant execute on function internal.public_surface_excluded_dataset_ids() to anon, authenticated, service_role;

alter policy "Enable read access for all users" on public.v2_datasets
using (
	data_access <> 'private'::access
	or (select auth.uid()) = user_id
	or (select public.can_view_all_private_data())
);

alter policy "Allow visible dataset labels read access" on public.v2_labels
using (
	exists (
		select 1
		from public.v2_datasets dataset
		where dataset.id = v2_labels.dataset_id
			and (
				dataset.data_access <> 'private'::access
				or (select auth.uid()) = dataset.user_id
				or (select public.can_view_all_private_data())
			)
			and (
				dataset.archived = false
				or (select auth.uid()) = dataset.user_id
			)
			and (
				(select auth.uid()) = dataset.user_id
				or (select public.can_view_all_private_data())
				or dataset.id not in (select internal.public_surface_excluded_dataset_ids())
			)
	)
);

-- Same columns and rows as 20260625090400; label flags are now computed only for
-- rows that survive the archive filters.
create or replace view public.public_dataset_archive_items
with (security_invoker = true) as
with latest_status as (
	select distinct on (dataset_id)
		dataset_id,
		is_cog_done,
		is_thumbnail_done,
		is_deadwood_done,
		is_forest_cover_done,
		is_metadata_done,
		has_error
	from public.v2_statuses
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
		d.data_access
	from public.v2_datasets d
	join latest_status s on s.dataset_id = d.id
	join public.v2_orthos o on o.dataset_id = d.id
	left join public.v2_thumbnails thumb on thumb.dataset_id = d.id
	left join public.v2_metadata meta on meta.dataset_id = d.id
	where (
			d.data_access <> 'private'::access
			or (select auth.uid()) = d.user_id
			or (select public.can_view_all_private_data())
		)
		and d.archived = false
		and s.is_cog_done = true
		and s.is_thumbnail_done = true
		and s.is_metadata_done = true
		and (
			s.has_error = false
			or (s.is_deadwood_done = true and s.is_forest_cover_done = false)
		)
		and d.id not in (select internal.public_surface_excluded_dataset_ids())
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
	exists (
		select 1
		from public.v2_labels label
		where label.dataset_id = base.id
			and label.label_source = 'visual_interpretation'::"LabelSource"
			and label.label_data = 'deadwood'::"LabelData"
	) as has_labels,
	exists (
		select 1
		from public.v2_labels label
		where label.dataset_id = base.id
			and label.label_source = 'model_prediction'::"LabelSource"
			and label.label_data = 'deadwood'::"LabelData"
	) as has_deadwood_prediction,
	base.data_access
from archive_base base
where base.admin_level_1 is not null;

-- The homepage stats read the same archive rows and also time out for anon. Its
-- area sum parsed bbox text in an inlined subquery, so each of the nine `coords`
-- references re-ran regexp_match per row. Materialize the parse; the result is
-- otherwise identical to 20260916160000.
create or replace view public.public_home_stats
with (security_invoker = true) as
with base as materialized (
	select
		archive.authors,
		archive.admin_level_1,
		ortho.ortho_file_size,
		archive.bbox
	from public.public_dataset_archive_items archive
	join public.v2_orthos ortho on ortho.dataset_id = archive.id
),
bbox_parts as materialized (
	select
		bbox,
		admin_level_1,
		ortho_file_size,
		regexp_match(
			bbox::text,
			'^BOX\(([-+0-9.eE]+) ([-+0-9.eE]+),([-+0-9.eE]+) ([-+0-9.eE]+)\)$'
		) as coords
	from base
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
	from bbox_parts
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

COMMIT;
