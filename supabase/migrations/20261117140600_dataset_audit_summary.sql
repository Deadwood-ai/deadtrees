-- The audit panel of the dataset page: what the audit found on a dataset (the Audit Review's
-- results, audit.dataset_results), for anyone who can see the dataset, so data users can judge
-- it: the decision, the georeferencing and the share of sample crops each prediction gets wrong,
-- with the deciding model's reasoning.
-- The page shows the findings once no review is required. (The date and phenology have their
-- own rows on the page.)
set local lock_timeout = '5s';

-- Owner-run, so callers without access to the audit schema read one dataset's results. Only
-- public.get_dataset_audit_summary calls it, for a dataset the caller can see; the internal
-- schema is not on the API. Each prediction layer also carries the deciding model's reasoning
-- on the sample crops it found errors on (major first): its one-sentence summary (prompt pq-v6
-- on), else its error sentences. The page shows it as the output of an automated audit with
-- vision language models.
create or replace function internal.dataset_audit_summary(p_dataset_id bigint)
returns jsonb
language sql stable security definer set search_path = ''
as $$
	with run as (
		-- the current prediction quality run's evidence and its deciding model (a name prefix)
		select coalesce(r.source_run_id, r.id) as evidence_run_id,
			coalesce(v.config -> 'rule_config' ->> 'decider', 'haiku') as decider
		from audit.current_runs c
		join audit.runs r on r.id = c.run_id
		join audit.check_versions v on v.id = r.check_version_id
		where c.dataset_id = p_dataset_id and c.check_key = 'prediction_quality'
	), reasoning as (
		select m.layer,
			jsonb_agg(jsonb_build_object('verdict', m.verdict, 'summary', nullif(m.details ->> 'summary', ''),
					'errors', coalesce(m.details -> 'errors', '[]'::jsonb))
				order by m.verdict = 'major' desc, m.crop_id) as items
		from run
		join audit.assessments m on m.run_id = run.evidence_run_id and m.assessor_kind = 'model'
			and m.crop_id is not null and starts_with(m.model, run.decider)
		where m.layer in ('deadwood', 'forest_cover') and m.verdict in ('minor', 'major')
			and (nullif(m.details ->> 'summary', '') is not null
				or (jsonb_typeof(m.details -> 'errors') = 'array' and jsonb_array_length(m.details -> 'errors') > 0))
			-- a crop the model could not assess does not count, as in audit.dataset_results
			and not exists (
				select 1 from audit.assessments g
				where g.run_id = m.run_id and g.crop_id = m.crop_id and g.assessor = m.assessor
					and g.layer = 'image' and g.verdict <> 'ok'
			)
		group by m.layer
	)
	select jsonb_build_object(
		'review_required', r.review_required,
		'evaluation_decision', r.evaluation_decision,
		'georef_status', r.georef_status,
		'georef_offset_m', r.georef_offset_m,
		'deadwood_total', r.deadwood_total,
		'deadwood_major', r.deadwood_major,
		'deadwood_minor', r.deadwood_minor,
		'deadwood_reasoning', coalesce((select items from reasoning where layer = 'deadwood'), '[]'::jsonb),
		'forest_cover_total', r.forest_cover_total,
		'forest_cover_major', r.forest_cover_major,
		'forest_cover_minor', r.forest_cover_minor,
		'forest_cover_reasoning', coalesce((select items from reasoning where layer = 'forest_cover'), '[]'::jsonb)
	)
	from audit.dataset_results r
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
