-- Audit results, worked out on read from the stored answers (DT-1606, docs/audit-checks.md).
--
-- Every result has one view; nothing is stored, so nothing is out of date after a rerun,
-- a new review or new rules:
--   tile_calls                     per tile and layer of the current prediction quality
--                                  run: a person's review of that prediction, else the
--                                  deciding judge's answer under the rules
--   evaluation_calls               per dataset: the current dataset evaluation run's keep,
--                                  exclude or unsure under the rules
--   current_dataset_human_reviews  per dataset and check: the newest review, and whether
--                                  it is stale (given on another ortho or date advice)
--   evaluation_decisions           the keep or exclude that counts: a person's review, the
--                                  old audit's keep, the check's call, the old audit's
--                                  exclude, in that order
--   dataset_outcomes               one row per dataset for the Audit Review and the dataset
--                                  page, with review_required
-- audit.is_dataset_excluded and audit.excluded_dataset_ids answer the public surface.
-- The AOI stage records its model in v2_aois.model_version, which the outcomes show.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Calls
-- ---------------------------------------------------------------------------

-- A model that could not assess the tile makes no call (verdict null); an ambiguous
-- answer is shown, and counts for no side. A tile review counts on the prediction it
-- showed, so a prediction rerun lets the models' answers count again.
create view audit.tile_calls
with (security_invoker = true)
as
with judged as (
	select distinct on (c.dataset_id, j.run_id, j.tile_id, j.layer)
		c.dataset_id, j.run_id, j.tile_id, j.layer,
		(c.inputs -> 'label_ids' ->> j.layer)::bigint as prediction_label_id,
		case when starts_with(j.judge, c.rules ->> 'decider') then j.id end as judgement_id
	from audit.current_runs c
	join audit.tile_vlm_judgements j on j.run_id = c.run_id
	where c.check_key = 'prediction_quality'
	order by c.dataset_id, j.run_id, j.tile_id, j.layer, starts_with(j.judge, c.rules ->> 'decider') desc nulls last, j.judge
), people as (
	select distinct on (h.dataset_id, h.tile_id, h.layer, h.prediction_label_id) h.*
	from audit.tile_human_reviews h
	order by h.dataset_id, h.tile_id, h.layer, h.prediction_label_id, h.created_at desc, h.id desc
)
select
	t.dataset_id,
	t.run_id,
	t.tile_id,
	t.layer,
	t.prediction_label_id,
	case when p.id is not null then p.verdict when d.verdict <> 'not_assessable' then d.verdict end as verdict,
	case when p.id is not null then p.note else d.summary end as summary,
	case when p.id is not null then p.problems else d.problems end as problems,
	p.id is not null as by_person,
	p.id as review_id,
	d.id as judgement_id
from judged t
left join audit.tile_vlm_judgements d on d.id = t.judgement_id
left join people p on p.dataset_id = t.dataset_id and p.tile_id = t.tile_id and p.layer = t.layer
	and p.prediction_label_id = t.prediction_label_id;

-- An empty COG excludes without a model, and so does a band layout that cannot be an RGB
-- photo; otherwise the deciding judge decides: ok and minor keep, major excludes, and no
-- answer (or not_assessable) leaves it to a person (decision null). Rules with
-- "call": "recorded" (the dataset evaluation's v1 and v2, before check_rules) read the call
-- the run's own rule recorded instead (runs.evidence.rule; its unsure is null).
create view audit.evaluation_calls
with (security_invoker = true)
as
select
	c.dataset_id,
	c.run_id,
	case
		when x.empty or x.not_rgb then 'exclude'
		when x.recorded then case x.rule ->> 'verdict' when 'ok' then 'keep' when 'minor' then 'keep' when 'major' then 'exclude' end
		when j.verdict in ('ok', 'minor') then 'keep'
		when j.verdict = 'major' then 'exclude'
	end::audit.decision as decision,
	case
		when x.empty then false
		when x.recorded then case when jsonb_typeof(x.rule -> 'fix_flags') = 'array' then (x.rule -> 'fix_flags') ? 'cog_issue' end
		else j.cog_issue
	end as cog_issue,
	case
		when x.empty then false
		when x.recorded then case when jsonb_typeof(x.rule -> 'fix_flags') = 'array' then (x.rule -> 'fix_flags') ? 'thumbnail_issue' end
		else j.thumbnail_issue
	end as thumbnail_issue,
	case
		when x.empty then 'broken_ortho'
		when x.not_rgb then 'not_rgb'
		when x.recorded then case when x.rule ->> 'verdict' = 'major' then x.rule ->> 'reason' end
		when j.verdict = 'major' then j.exclude_reason
	end as reason,
	case
		when x.empty or x.not_rgb then 'major'
		when x.recorded then nullif(x.rule ->> 'verdict', 'unsure')
		else j.verdict::text
	end::audit.verdict as verdict,
	case when x.recorded then x.rule ->> 'summary' else j.summary end as summary,
	case when not x.recorded then j.id end as judgement_id,
	c.finished_at
from audit.current_runs c
join audit.runs r on r.id = c.run_id
cross join lateral (
	select coalesce((r.evidence ->> 'empty')::boolean, false) as empty,
		coalesce((r.evidence -> 'band_check' ->> 'likelihood')::real >= (c.rules ->> 'band_major_at')::real, false) as not_rgb,
		coalesce(c.rules ->> 'call' = 'recorded', false) as recorded,
		r.evidence -> 'rule' as rule
) x
left join lateral (
	select d.id, d.verdict, d.cog_issue, d.thumbnail_issue, d.exclude_reason, d.summary
	from audit.dataset_vlm_judgements d
	where d.run_id = c.run_id and starts_with(d.judge, c.rules ->> 'decider')
	order by d.judge
	limit 1
) j on true
where c.check_key = 'dataset_evaluation';

-- ---------------------------------------------------------------------------
-- People's dataset reviews and the decision
-- ---------------------------------------------------------------------------

create view audit.current_dataset_human_reviews
with (security_invoker = true)
as
select
	n.dataset_id,
	n.check_key,
	n.id as review_id,
	n.evidence_key is distinct from internal.audit_evidence_key(n.dataset_id, n.check_key) as stale,
	n.decision,
	n.exclude_reason,
	n.cog_issue,
	n.thumbnail_issue,
	n.georef_status,
	n.date_replace,
	n.note,
	n.in_benchmark,
	n.reviewed_by,
	n.created_at
from (
	select distinct on (h.dataset_id, h.check_key) h.*
	from audit.dataset_human_reviews h
	order by h.dataset_id, h.check_key, h.created_at desc, h.id desc
) n;

-- One row per dataset with an evaluation answer; decision keep or exclude, null while the
-- check is unsure and nothing else decides (the dataset needs a person). The old audit's
-- exclusions reasons the evaluation does not count, so one holds only until the check
-- decides. Filtered on dataset_id, the planner reads only that dataset's rows.
create view audit.evaluation_decisions
with (security_invoker = true)
as
select distinct on (d.dataset_id)
	d.dataset_id, d.decision, d.source, d.verdict, d.output, d.decided_at
from (
	select r.dataset_id, r.decision, 'reviewer'::text as source, null::audit.verdict as verdict,
		jsonb_build_object('cog_issue', r.cog_issue, 'thumbnail_issue', r.thumbnail_issue, 'reason', r.exclude_reason)
			as output,
		r.created_at as decided_at, 1 as priority
	from audit.current_dataset_human_reviews r
	where r.check_key = 'dataset_evaluation' and not r.stale
	union all
	select l.dataset_id, l.decision, 'legacy', null, null, l.decided_at,
		case l.decision when 'keep' then 2 else 4 end
	from audit.legacy_decisions l
	union all
	select c.dataset_id, c.decision, case when c.decision is not null then 'check' end, c.verdict,
		jsonb_build_object('cog_issue', c.cog_issue, 'thumbnail_issue', c.thumbnail_issue, 'reason', c.reason),
		c.finished_at, case when c.decision is null then 5 else 3 end
	from audit.evaluation_calls c
) d
order by d.dataset_id, d.priority;

-- Narrow and owner-run, so row policies and the public surface can ask without seeing the
-- audit tables.
create function audit.is_dataset_excluded(p_dataset_id bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
	select coalesce((select d.decision = 'exclude' from audit.evaluation_decisions d where d.dataset_id = p_dataset_id), false);
$$;

create function audit.excluded_dataset_ids()
returns setof bigint
language sql stable security definer set search_path = ''
as $$
	select d.dataset_id from audit.evaluation_decisions d where d.decision = 'exclude';
$$;

revoke all on function audit.is_dataset_excluded(bigint) from public, anon, authenticated;
revoke all on function audit.excluded_dataset_ids() from public, anon, authenticated;
grant execute on function audit.is_dataset_excluded(bigint) to service_role, analyst;
grant execute on function audit.excluded_dataset_ids() to service_role, analyst;

-- ---------------------------------------------------------------------------
-- AOI model version
-- ---------------------------------------------------------------------------

alter table public.v2_aois add column model_version text;
comment on column public.v2_aois.model_version is 'The model that predicted an ml_prediction AOI, e.g. aoi_segmentation_v1.';

-- The backfill changes no geometry, so the tile membership refresh stays off for it.
alter table public.v2_aois disable trigger v2_aois_refresh_membership_trg;
update public.v2_aois set model_version = 'aoi_segmentation_v1'
where source = 'ml_prediction' and model_version is null and notes = 'Auto-generated by aoi_segmentation_v1';
alter table public.v2_aois enable trigger v2_aois_refresh_membership_trg;

-- ---------------------------------------------------------------------------
-- One row per dataset
-- ---------------------------------------------------------------------------

-- review_required names the checks a person must look at, in step order:
--   evaluation  the check is unsure and no current review answers it
--   aoi         processing finished and no AOI exists
--   georef      the georeferencing status is needs_review and no current review answers it
--   date        the date review is stale: the estimate's advice flipped since (a review
--               stays valid while the advice is unchanged)
-- The prediction layers never need review: their quality is reviewed on a sample.
-- "Current" reviews were given on the dataset's present ortho (or date advice).
create view audit.dataset_outcomes
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
	array_remove(array[
		case when evaluation_run_id is not null and evaluation_call is null and not evaluation_reviewed then 'evaluation' end,
		case when is_processing_done and not aoi_exists then 'aoi' end,
		case when georef_check_status = 'needs_review' and not georef_reviewed then 'georef' end,
		case when date_review_stale then 'date' end
	], null) as review_required,
	in_benchmark
from results;

comment on view audit.dataset_outcomes is
	'Audit Review and dataset page: one row per dataset with every check''s outcome and review_required (docs/audit-checks.md).';

-- ---------------------------------------------------------------------------
-- The dataset page's audit panel
-- ---------------------------------------------------------------------------

-- Owner-run, so callers without access to the audit schema read one dataset's outcome.
-- Only public.get_dataset_audit_summary calls it, for a dataset the caller can see; the
-- internal schema is not on the API. Each prediction layer also carries the deciding
-- model's reasoning on the sample tiles it found errors on (major first): its one-sentence
-- summary, else its error sentences. A tile a person answered shows no model reasoning.
create function internal.dataset_audit_summary(p_dataset_id bigint)
returns jsonb
language sql stable security definer set search_path = ''
as $$
	with reasoning as (
		select c.layer,
			jsonb_agg(jsonb_build_object('verdict', c.verdict, 'summary', nullif(j.summary, ''),
					'errors', case when jsonb_typeof(j.raw -> 'errors') = 'array' then j.raw -> 'errors' else '[]'::jsonb end)
				order by c.verdict = 'major' desc, c.tile_id) as items
		from audit.tile_calls c
		join audit.tile_vlm_judgements j on j.id = c.judgement_id
		where c.dataset_id = p_dataset_id and not c.by_person and c.verdict in ('minor', 'major')
			and (nullif(j.summary, '') is not null
				or (jsonb_typeof(j.raw -> 'errors') = 'array' and jsonb_array_length(j.raw -> 'errors') > 0))
		group by c.layer
	)
	select jsonb_build_object(
		'review_required', r.review_required,
		'evaluation_decision', r.evaluation_decision,
		'georef_status', r.georef_status,
		'georef_offset_m', r.georef_offset_m,
		'date_replace', r.date_replace,
		'date_new', r.date_new,
		'deadwood_total', r.deadwood_total,
		'deadwood_major', r.deadwood_major,
		'deadwood_minor', r.deadwood_minor,
		'deadwood_reasoning', coalesce((select items from reasoning where layer = 'deadwood'), '[]'::jsonb),
		'forest_cover_total', r.forest_cover_total,
		'forest_cover_major', r.forest_cover_major,
		'forest_cover_minor', r.forest_cover_minor,
		'forest_cover_reasoning', coalesce((select items from reasoning where layer = 'forest_cover'), '[]'::jsonb)
	)
	from audit.dataset_outcomes r
	where r.dataset_id = p_dataset_id;
$$;
revoke all on function internal.dataset_audit_summary(bigint) from public;
grant execute on function internal.dataset_audit_summary(bigint) to anon, authenticated, service_role;

-- Caller-run: the dataset row is read under its own policies, so a dataset the caller cannot
-- see has no summary (null).
create function public.get_dataset_audit_summary(p_dataset_id bigint)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
	select internal.dataset_audit_summary(d.id) from public.v2_datasets d where d.id = p_dataset_id;
$$;
revoke all on function public.get_dataset_audit_summary(bigint) from public;
grant execute on function public.get_dataset_audit_summary(bigint) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Grants (views run as the caller: auditors read through the tables' policies)
-- ---------------------------------------------------------------------------

grant select on audit.tile_calls, audit.evaluation_calls, audit.current_dataset_human_reviews,
	audit.evaluation_decisions, audit.dataset_outcomes to authenticated, analyst;
grant all on audit.tile_calls, audit.evaluation_calls, audit.current_dataset_human_reviews,
	audit.evaluation_decisions, audit.dataset_outcomes to service_role;
