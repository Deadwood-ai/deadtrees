-- Audit Review: one row of check outputs per dataset (audit.dataset_results).
--
-- Every dataset, in any processing stage, with what each check reports: the evaluation
-- decision (audit.evaluation_decisions) and the COG and thumbnail issues, the AOI, the
-- georeferencing status and offset, the acquisition date replacement (AerialStamp), the
-- phenology probability and the prediction quality crop counts per layer. Georeferencing
-- and the date are computed here from the stored check rows by versioned functions, so a
-- new rule needs no rerun. Nothing is derived from a check's mode any more.
--
-- review_required names the checks a person must look at, in step order:
--   evaluation    the current rule verdict is unsure and no reviewer answered on the
--                 current evidence
--   aoi           processing finished and no AOI exists
--   georef        the status is needs_review and no reviewer answered on the current evidence
--   date          AerialStamp dated the dataset again after a reviewer's override; the
--                 override no longer counts until a reviewer answers on the new estimate
-- The prediction layers never need review: their quality is reviewed on a sample instead.
-- "On the current evidence": an answer given on the current run, on the run it recomputes
-- from, or on a run that judged the same non-empty inputs (ortho sha256, prediction labels).
--
-- audit.review_queue and audit.disagreements are replaced by this view.
set local lock_timeout = '5s';

drop view audit.review_queue;
drop view audit.disagreements;

-- Georeferencing output, rules georef-rules-v1 (docs/georef-check.md):
--   estimated     the deciding references agree; offset_m is their median p90
--   not_passed    a coordinate looks lost (Poor, gross)
--   no_reference  no reference qualified
--   needs_review  references qualified but none decides, or they conflict; offset_m is
--                 the p90 of the best supported qualified reference, as evidence
-- A reviewer answers needs_review with {"status": "passed" | "not_passed"} (passed: within 15 m).
create function audit.georef_output_v1(p_check public.v2_georef_checks)
returns jsonb
language sql immutable set search_path = ''
as $$
	with refs as (
		select (e ->> 'support')::real as support, (e ->> 'p90_m')::real as p90_m
		from jsonb_array_elements(p_check.reference_evidence) e
		where coalesce((e ->> 'qualified')::boolean, false)
	)
	select case
		when p_check.reason = 'references_agree' then
			jsonb_build_object('status', 'estimated', 'offset_m', p_check.p90_m)
		when p_check.decision = 'poor' and p_check.evidence_level = 'gross' then
			jsonb_build_object('status', 'not_passed', 'offset_m', p_check.p90_m)
		when not exists (select 1 from refs) then
			jsonb_build_object('status', 'no_reference', 'offset_m', null)
		else jsonb_build_object('status', 'needs_review', 'offset_m',
			(select p90_m from refs order by support desc nulls last, p90_m limit 1))
	end;
$$;

-- Acquisition date output of AerialStamp (doy_estimation_v1, docs/doy-estimation.md). The
-- check only stores this; it never changes v2_datasets.
--   reason   mismatch (the recorded date is far off), missing_month (only a year was
--            recorded), missing_day (only a month, and the prediction falls in it)
--   replace  a reason and a confident estimate: one mode and an 80% range of at most 90 days
-- A reviewer overrides replace with {"replace": bool} and a note.
create function audit.acquisition_date_output_v1(p_estimate public.v2_acquisition_date_estimates)
returns jsonb
language sql immutable set search_path = ''
as $$
	select jsonb_build_object(
		'replace', r.replace,
		'new_date', case when r.replace then p_estimate.predicted_date end,
		'predicted_date', p_estimate.predicted_date,
		'hdi80_days', p_estimate.hdi80_days,
		'n_modes', p_estimate.n_modes,
		'reason', r.reason,
		'model_version', p_estimate.model_version,
		'estimated_at', p_estimate.updated_at
	)
	from (select reason, reason is not null and p_estimate.n_modes = 1 and p_estimate.hdi80_days <= 90 as replace
		from (select case
			when p_estimate.is_mismatch then 'mismatch'
			when p_estimate.recorded_precision = 'year' then 'missing_month'
			when p_estimate.recorded_precision = 'month'
				and date_trunc('month', p_estimate.predicted_date)
					= make_date(p_estimate.recorded_year, p_estimate.recorded_month, 1) then 'missing_day'
		end as reason) c) r;
$$;

revoke all on function audit.georef_output_v1(public.v2_georef_checks) from public, anon;
revoke all on function audit.acquisition_date_output_v1(public.v2_acquisition_date_estimates) from public, anon;
grant execute on function audit.georef_output_v1(public.v2_georef_checks) to authenticated, service_role, analyst;
grant execute on function audit.acquisition_date_output_v1(public.v2_acquisition_date_estimates)
	to authenticated, service_role, analyst;

create view audit.dataset_results
with (security_invoker = true)
as
with evidence as (
	-- the run whose results count per dataset and check, and the evidence it judged
	select c.dataset_id, c.check_key, c.run_id, v.config,
		coalesce(r.source_run_id, r.id) as evidence_run_id,
		coalesce(src.inputs, r.inputs) as evidence_inputs
	from audit.current_runs c
	join audit.runs r on r.id = c.run_id
	left join audit.runs src on src.id = r.source_run_id
	join audit.check_versions v on v.id = r.check_version_id
), reviews as (
	-- native reviewer answers on the current evidence, the latest per target and layer
	select distinct on (p.dataset_id, p.check_key, p.crop_id, p.layer)
		p.dataset_id, p.check_key, p.crop_id, p.layer, p.verdict, p.output
	from audit.assessments p
	join evidence e on e.dataset_id = p.dataset_id and e.check_key = p.check_key
	join audit.runs pr on pr.id = p.run_id
	left join audit.runs ps on ps.id = pr.source_run_id
	where p.assessor_kind = 'person' and p.imported_from is null
		and (coalesce(ps.id, pr.id) = e.evidence_run_id
			or (e.evidence_inputs <> '{}'::jsonb and coalesce(ps.inputs, pr.inputs) = e.evidence_inputs))
	order by p.dataset_id, p.check_key, p.crop_id, p.layer, p.created_at desc, p.id desc
), reviewed as (
	select r.dataset_id,
		bool_or(r.check_key = 'dataset_evaluation') as evaluation,
		bool_or(r.check_key = 'georef') as georef,
		max(r.output ->> 'status') filter (where r.check_key = 'georef' and r.output ->> 'status' in ('passed', 'not_passed'))
			as georef_status
	from reviews r
	where r.crop_id is null
	group by r.dataset_id
), evaluation as (
	-- the current dataset evaluation run's rule rows: the worst verdict, and the COG and
	-- thumbnail issues (output of rule v3; rule v2 named them in details.fix_flags)
	select a.dataset_id,
		(array_agg(a.verdict order by array_position(array['major', 'unsure', 'minor', 'ok']::audit.verdict[], a.verdict)))[1]
			as verdict,
		bool_or(coalesce((a.output ->> 'cog_issue')::boolean, (a.details -> 'fix_flags') ? 'cog_issue')) as cog_issue,
		bool_or(coalesce((a.output ->> 'thumbnail_issue')::boolean, (a.details -> 'fix_flags') ? 'thumbnail_issue'))
			as thumbnail_issue
	from evidence e
	join audit.assessments a on a.run_id = e.run_id and a.assessor_kind = 'rule' and a.crop_id is null
	where e.check_key = 'dataset_evaluation'
	group by a.dataset_id
), judges as (
	-- each judge's rows on the crops of the current prediction quality run, with its m0 gate and
	-- whether it is the deciding model (rule_config.decider, a model name prefix; Haiku by default)
	select m.dataset_id, m.crop_id, m.layer, m.verdict,
		starts_with(m.model, coalesce(e.config -> 'rule_config' ->> 'decider', 'haiku')) as decides,
		bool_and(m.verdict = 'ok') filter (where m.layer = 'image') over (partition by m.crop_id, m.assessor) as assessable
	from evidence e
	join audit.assessments m on m.run_id = e.evidence_run_id and m.assessor_kind = 'model' and m.crop_id is not null
	where e.check_key = 'prediction_quality'
), crops as (
	-- the call per crop and layer is the deciding model's verdict where it could assess the crop;
	-- the other models are shown, not counted. An ambiguous crop counts for no side.
	select j.dataset_id, j.crop_id, j.layer, j.verdict as call
	from judges j
	where j.decides and j.assessable and j.layer in ('deadwood', 'forest_cover') and j.verdict in ('ok', 'minor', 'major')
), quality as (
	select c.dataset_id,
		count(*) filter (where c.layer = 'deadwood') as deadwood_total,
		count(*) filter (where c.layer = 'deadwood' and c.call = 'major') as deadwood_major,
		count(*) filter (where c.layer = 'deadwood' and c.call = 'minor') as deadwood_minor,
		count(*) filter (where c.layer = 'deadwood' and c.call = 'ok') as deadwood_ok,
		count(*) filter (where c.layer = 'forest_cover') as forest_cover_total,
		count(*) filter (where c.layer = 'forest_cover' and c.call = 'major') as forest_cover_major,
		count(*) filter (where c.layer = 'forest_cover' and c.call = 'minor') as forest_cover_minor,
		count(*) filter (where c.layer = 'forest_cover' and c.call = 'ok') as forest_cover_ok
	from crops c
	group by c.dataset_id
), date_reviews as (
	-- a reviewer's replace yes/no overrides the check; the latest native answer wins
	select distinct on (p.dataset_id) p.dataset_id, (p.output ->> 'replace')::boolean as replace, p.created_at
	from audit.assessments p
	where p.check_key = 'acquisition_date' and p.assessor_kind = 'person' and p.imported_from is null
		and p.crop_id is null and jsonb_typeof(p.output -> 'replace') = 'boolean'
	order by p.dataset_id, p.created_at desc, p.id desc
), aois as (
	-- the AOI the checks work in: a reviewer's before the predicted one, newest first
	select distinct on (a.dataset_id) a.dataset_id, a.created_at, a.source, a.model_version
	from public.v2_aois a
	order by a.dataset_id, array_position(array['manual_correction', 'manual', 'ml_prediction'], a.source),
		a.created_at desc, a.id desc
), people as (
	select p.dataset_id, max(p.created_at) as last_reviewed_at
	from audit.assessments p
	where p.assessor_kind = 'person' and p.imported_from is null
	group by p.dataset_id
), benchmarked as (
	select distinct m.dataset_id
	from audit.benchmark_members m
	join audit.benchmarks b on b.id = m.benchmark_id and b.frozen_at is null
), runs as (
	select dataset_id, array_agg(check_key order by check_key) as checks_run
	from audit.current_runs
	group by dataset_id
), results as (
	select
		d.id as dataset_id,
		s.current_status,
		coalesce(s.current_status = 'idle' and not s.has_error and s.is_cog_done
			and (coalesce(s.is_combined_model_done, false) or (s.is_deadwood_done and s.is_forest_cover_done)), false)
			as is_processing_done,
		ed.decision as evaluation_decision,
		ed.source as evaluation_source,
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
		-- an override given before the current estimate is stale: it waits for a reviewer again
		case when dr.created_at >= (dt.output ->> 'estimated_at')::timestamptz or dt.output is null then dr.replace end
			as date_review_replace,
		coalesce(dr.created_at < (dt.output ->> 'estimated_at')::timestamptz, false) as date_review_stale,
		public.phenology_probability_at(meta.metadata -> 'phenology' -> 'phenology_curve',
			d.aquisition_year, d.aquisition_month, d.aquisition_day) as phenology_probability,
		q.deadwood_total, q.deadwood_major, q.deadwood_minor, q.deadwood_ok,
		q.forest_cover_total, q.forest_cover_major, q.forest_cover_minor, q.forest_cover_ok,
		ev.verdict as evaluation_verdict,
		rv.evaluation as evaluation_reviewed,
		rv.georef as georef_reviewed,
		people.last_reviewed_at,
		bm.dataset_id is not null as in_benchmark,
		coalesce(cr.checks_run, '{}') as checks_run
	from public.v2_datasets d
	left join public.v2_statuses s on s.dataset_id = d.id
	left join public.v2_metadata meta on meta.dataset_id = d.id
	left join audit.evaluation_decisions ed on ed.dataset_id = d.id
	left join evaluation ev on ev.dataset_id = d.id
	left join aois aoi on aoi.dataset_id = d.id
	left join lateral (select audit.georef_output_v1(c) as output from public.v2_georef_checks c where c.dataset_id = d.id) g on true
	left join lateral (
		select audit.acquisition_date_output_v1(e) as output from public.v2_acquisition_date_estimates e where e.dataset_id = d.id
	) dt on true
	left join date_reviews dr on dr.dataset_id = d.id
	left join reviewed rv on rv.dataset_id = d.id
	left join quality q on q.dataset_id = d.id
	left join people on people.dataset_id = d.id
	left join benchmarked bm on bm.dataset_id = d.id
	left join runs cr on cr.dataset_id = d.id
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
	case when date_review_replace is not null then 'reviewer' when date_output is not null then 'check' end as date_source,
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
		case when evaluation_verdict = 'unsure' and not coalesce(evaluation_reviewed, false) then 'evaluation' end,
		case when is_processing_done and not aoi_exists then 'aoi' end,
		case when georef_check_status = 'needs_review' and not coalesce(georef_reviewed, false) then 'georef' end,
		case when date_review_stale then 'date' end
	], null) as review_required,
	last_reviewed_at,
	in_benchmark,
	checks_run
from results;

comment on view audit.dataset_results is
	'Audit Review: one row per dataset with every check''s output, and review_required (docs/audit-checks.md).';

grant select on audit.dataset_results to authenticated, analyst;
grant all on audit.dataset_results to service_role;
