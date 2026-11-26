-- An excluded dataset needs no review (DT-1607).
--
-- Once audit.evaluation_decisions excludes a dataset (a reviewer, the check, or the earlier
-- manual audit), its AOI, georeferencing and date no longer matter: review_required is empty,
-- so it leaves the Pending audit reviews tab and Save & Next skips it. The view keeps its
-- columns; only review_required changes.
set local lock_timeout = '5s';

-- review_required names the checks a person must look at, in step order:
--   evaluation  the check is unsure and no current review answers it
--   aoi         processing finished and no AOI exists
--   georef      the georeferencing status is needs_review and no current review answers it
--   date        the date review is stale: the estimate's advice flipped since (a review
--               stays valid while the advice is unchanged)
-- The prediction layers never need review: their quality is reviewed on a sample.
-- An excluded dataset needs none at all: once the evaluation excludes it, its other checks
-- do not matter.
-- "Current" reviews were given on the dataset's present ortho (or date advice).
create or replace view audit.dataset_outcomes
with (security_invoker = true)
as
with reviews as (
	select r.dataset_id,
		bool_or(r.check_key = 'dataset_evaluation' and not r.stale) as evaluation_reviewed,
		bool_or(r.check_key = 'georef' and not r.stale) as georef_reviewed,
		max(r.georef_status) filter (where r.check_key = 'georef' and not r.stale) as georef_status,
		bool_or(r.date_replace) filter (where r.check_key = 'acquisition_date' and not r.stale) as date_replace,
		bool_or(r.check_key = 'acquisition_date' and r.stale) as date_stale
	from audit.current_dataset_human_reviews r
	group by r.dataset_id
), quality as (
	select c.dataset_id,
		count(*) filter (where c.layer = 'deadwood') as deadwood_total,
		count(*) filter (where c.layer = 'deadwood' and c.verdict = 'major') as deadwood_major,
		count(*) filter (where c.layer = 'deadwood' and c.verdict = 'minor') as deadwood_minor,
		count(*) filter (where c.layer = 'deadwood' and c.verdict = 'ok') as deadwood_ok,
		count(*) filter (where c.layer = 'forest_cover') as forest_cover_total,
		count(*) filter (where c.layer = 'forest_cover' and c.verdict = 'major') as forest_cover_major,
		count(*) filter (where c.layer = 'forest_cover' and c.verdict = 'minor') as forest_cover_minor,
		count(*) filter (where c.layer = 'forest_cover' and c.verdict = 'ok') as forest_cover_ok
	from audit.tile_calls c
	where c.verdict in ('ok', 'minor', 'major')
	group by c.dataset_id
), aois as (
	-- the AOI the checks work in: a reviewer's before the predicted one, newest first
	select distinct on (a.dataset_id) a.dataset_id, a.created_at, a.source, a.model_version
	from public.v2_aois a
	order by a.dataset_id, array_position(array['manual_correction', 'manual', 'ml_prediction'], a.source),
		a.created_at desc, a.id desc
), results as (
	select
		d.id as dataset_id,
		s.current_status,
		coalesce(s.current_status = 'idle' and not s.has_error and s.is_cog_done
			and (coalesce(s.is_combined_model_done, false) or (s.is_deadwood_done and s.is_forest_cover_done)), false)
			as is_processing_done,
		ed.decision as evaluation_decision,
		ed.source as evaluation_source,
		ev.decision as evaluation_call,
		ev.run_id as evaluation_run_id,
		coalesce((ed.output ->> 'cog_issue')::boolean, ev.cog_issue) as cog_issue,
		coalesce((ed.output ->> 'thumbnail_issue')::boolean, ev.thumbnail_issue) as thumbnail_issue,
		aoi.dataset_id is not null as aoi_exists,
		aoi.created_at as aoi_created_at,
		aoi.source as aoi_source,
		aoi.model_version as aoi_model_version,
		g.output ->> 'status' as georef_check_status,
		(g.output ->> 'offset_m')::real as georef_offset_m,
		rv.georef_status as georef_review_status,
		dt.output as date_output,
		rv.date_replace as date_review_replace,
		coalesce(rv.date_stale, false) as date_review_stale,
		public.phenology_probability_at(meta.metadata -> 'phenology' -> 'phenology_curve',
			d.aquisition_year, d.aquisition_month, d.aquisition_day) as phenology_probability,
		q.deadwood_total, q.deadwood_major, q.deadwood_minor, q.deadwood_ok,
		q.forest_cover_total, q.forest_cover_major, q.forest_cover_minor, q.forest_cover_ok,
		coalesce(rv.evaluation_reviewed, false) as evaluation_reviewed,
		coalesce(rv.georef_reviewed, false) as georef_reviewed,
		exists (select 1 from audit.dataset_human_reviews h where h.dataset_id = d.id and h.in_benchmark)
			or exists (select 1 from audit.tile_human_reviews h where h.dataset_id = d.id and h.in_benchmark) as in_benchmark
	from public.v2_datasets d
	left join public.v2_statuses s on s.dataset_id = d.id
	left join public.v2_metadata meta on meta.dataset_id = d.id
	left join audit.evaluation_decisions ed on ed.dataset_id = d.id
	left join audit.evaluation_calls ev on ev.dataset_id = d.id
	left join aois aoi on aoi.dataset_id = d.id
	left join lateral (select audit.georef_output_v1(c) as output from public.v2_georef_checks c where c.dataset_id = d.id) g on true
	left join lateral (
		select audit.acquisition_date_output_v1(e) as output from public.v2_acquisition_date_estimates e where e.dataset_id = d.id
	) dt on true
	left join reviews rv on rv.dataset_id = d.id
	left join quality q on q.dataset_id = d.id
)
select
	dataset_id,
	current_status,
	is_processing_done,
	evaluation_decision,
	evaluation_source,
	cog_issue,
	thumbnail_issue,
	aoi_exists,
	aoi_created_at,
	aoi_source,
	aoi_model_version,
	coalesce(georef_review_status, georef_check_status) as georef_status,
	georef_offset_m,
	case when georef_review_status is not null then 'reviewer' when georef_check_status is not null then 'check' end
		as georef_source,
	coalesce(date_review_replace, (date_output ->> 'replace')::boolean) as date_replace,
	case when coalesce(date_review_replace, (date_output ->> 'replace')::boolean) then (date_output ->> 'predicted_date')::date end
		as date_new,
	(date_output ->> 'predicted_date')::date as date_predicted,
	(date_output ->> 'hdi80_days')::integer as date_hdi80_days,
	date_output ->> 'model_version' as date_model_version,
	(date_output ->> 'estimated_at')::timestamptz as date_estimated_at,
	phenology_probability,
	deadwood_total,
	deadwood_major,
	deadwood_minor,
	deadwood_ok,
	forest_cover_total,
	forest_cover_major,
	forest_cover_minor,
	forest_cover_ok,
	case when evaluation_decision = 'exclude' then '{}'::text[] else array_remove(array[
		case when evaluation_run_id is not null and evaluation_call is null and not evaluation_reviewed then 'evaluation' end,
		case when is_processing_done and not aoi_exists then 'aoi' end,
		case when georef_check_status = 'needs_review' and not georef_reviewed then 'georef' end,
		case when date_review_stale then 'date' end
	], null) end as review_required,
	in_benchmark
from results;

comment on view audit.dataset_outcomes is
	'Audit Review and dataset page: one row per dataset with every check''s outcome and review_required (docs/audit-checks.md).';
