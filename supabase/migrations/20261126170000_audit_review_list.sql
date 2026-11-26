-- The Audit Review list, paged on the server (DT-1607).
--
-- The list loaded every row of audit.dataset_outcomes page after page (each page worked the
-- whole view out again) and filtered in the browser. audit.review_list has one row per dataset
-- with what the table, its tabs and its filters need, so the page asks for one page of rows,
-- its count and the tab counts. audit.review_list_options() gives the filters' choices.
set local lock_timeout = '5s';

-- One row per dataset that is not archived. outcome is the dataset's row of
-- audit.dataset_outcomes, worked out only for the rows a query returns (a page); the other
-- outcome columns repeat what the list filters and sorts on, and cost only when a query uses
-- them. Readers see what the underlying tables' policies let them see.
--   *_major_share  major crops in percent of the layer's crops (null when it has none);
--                  major_share is the larger of the two
--   is_*_done, current_status, has_error, failed_stage, error_message
--                  the processing stages; failed_stage names the stage that failed as the
--                  factory does (v2_status names, 'unknown' when not recorded)
--   flags          user reports, open or acknowledged
--   edits          suggested prediction edits waiting for a decision
--   reviewers      who answered on the dataset on the Audit Review (user ids)
create view audit.review_list
with (security_invoker = true)
as
select
	d.id as dataset_id,
	d.aquisition_year,
	d.aquisition_month,
	d.aquisition_day,
	(meta.metadata ->> 'gadm')::jsonb ->> 'admin_level_1' as admin_level_1,
	(meta.metadata ->> 'gadm')::jsonb ->> 'admin_level_3' as admin_level_3,
	coalesce(s.has_ml_tiles, false) as has_ml_tiles,
	(select r from audit.dataset_outcomes r where r.dataset_id = d.id) as outcome,
	o.is_processing_done,
	o.evaluation_decision,
	o.georef_status,
	o.georef_offset_m,
	o.date_replace,
	o.phenology_probability,
	o.review_required,
	o.in_benchmark,
	round(100.0 * o.deadwood_major / nullif(o.deadwood_total, 0))::integer as deadwood_major_share,
	round(100.0 * o.forest_cover_major / nullif(o.forest_cover_total, 0))::integer as forest_cover_major_share,
	greatest(round(100.0 * o.deadwood_major / nullif(o.deadwood_total, 0)),
		round(100.0 * o.forest_cover_major / nullif(o.forest_cover_total, 0)))::integer as major_share,
	s.current_status,
	coalesce(s.is_upload_done, false) as is_upload_done,
	coalesce(s.is_odm_done, false) as is_odm_done,
	coalesce(s.is_ortho_done, false) as is_ortho_done,
	coalesce(s.is_metadata_done, false) as is_metadata_done,
	coalesce(s.is_cog_done, false) as is_cog_done,
	coalesce(s.is_thumbnail_done, false) as is_thumbnail_done,
	coalesce(s.is_deadwood_done, false) as is_deadwood_done,
	coalesce(s.is_forest_cover_done, false) as is_forest_cover_done,
	coalesce(s.is_combined_model_done, false) as is_combined_model_done,
	coalesce(s.is_aoi_done, false) as is_aoi_done,
	coalesce(s.is_embeddings_done, false) as is_embeddings_done,
	coalesce(s.is_doy_estimation_done, false) as is_doy_estimation_done,
	coalesce(s.is_georef_check_done, false) as is_georef_check_done,
	coalesce(s.has_error, false) as has_error,
	case when s.has_error then public.factory_failure_stage(s.error_stage, s.error_message) end as failed_stage,
	case when s.has_error then left(s.error_message, 500) end as error_message,
	coalesce(f.flags, 0) as flags,
	coalesce(c.edits, 0) as edits,
	exists (select 1 from public.reference_datasets r where r.dataset_id = d.id) as reference,
	coalesce(rv.reviewers, '{}') as reviewers
from public.v2_datasets d
join audit.dataset_outcomes o on o.dataset_id = d.id
left join public.v2_statuses s on s.dataset_id = d.id
left join public.v2_metadata meta on meta.dataset_id = d.id
left join (
	select dataset_id, count(*)::integer as flags
	from public.dataset_flags
	where status in ('open', 'acknowledged')
	group by dataset_id
) f on f.dataset_id = d.id
left join (
	select dataset_id, count(*)::integer as edits
	from public.v2_geometry_corrections
	where review_status = 'pending'
	group by dataset_id
) c on c.dataset_id = d.id
left join (
	select dataset_id, array_agg(distinct reviewed_by) as reviewers
	from audit.dataset_human_reviews
	where reviewed_by is not null
	group by dataset_id
) rv on rv.dataset_id = d.id
where not d.archived;

comment on view audit.review_list is
	'Audit Review list: one row per dataset that is not archived, paged and filtered by PostgREST (docs/audit-checks.md).';

-- The list's filter choices: the countries and processing statuses (besides idle) of the
-- datasets it lists, and who reviewed on the Audit Review, with their emails for auditors.
create function audit.review_list_options()
returns jsonb
language sql stable security invoker set search_path = ''
as $$
	select jsonb_build_object(
		'countries', coalesce((
			select jsonb_agg(c order by c)
			from (
				select distinct (meta.metadata ->> 'gadm')::jsonb ->> 'admin_level_1' as c
				from public.v2_datasets d
				join public.v2_metadata meta on meta.dataset_id = d.id
				where not d.archived
			) countries
			where c is not null
		), '[]'),
		'stages', coalesce((
			select jsonb_agg(st order by st)
			from (
				select distinct s.current_status::text as st
				from public.v2_statuses s
				join public.v2_datasets d on d.id = s.dataset_id
				where not d.archived and s.current_status <> 'idle'
			) stages
		), '[]'),
		'reviewers', coalesce((
			select jsonb_agg(jsonb_build_object('id', r.id, 'email', e.email) order by coalesce(e.email, r.id::text))
			from (select distinct reviewed_by as id from audit.dataset_human_reviews where reviewed_by is not null) r
			left join public.get_user_emails(array(
				select distinct reviewed_by from audit.dataset_human_reviews where reviewed_by is not null
			)) e on e.user_id = r.id
		), '[]')
	);
$$;
revoke all on function audit.review_list_options() from public;

-- The view names the failed stage as the factory does; the function is pure.
grant execute on function public.factory_failure_stage(text, text) to authenticated, analyst;

grant select on audit.review_list to authenticated, analyst;
grant all on audit.review_list to service_role;
grant execute on function audit.review_list_options() to authenticated, service_role;
