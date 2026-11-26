-- The audit summary says why a dataset was excluded (DT-1614).
--
-- The owner's dataset status panel shows the summary, and an excluded dataset should say why in
-- plain words. internal.dataset_audit_summary gains evaluation_reason: the reason code of the
-- evaluation decision that counts (audit.evaluation_decisions.output ->> 'reason', the check's or
-- a reviewer's), only when that decision is exclude. Only the fixed codes pass; anything else a
-- review might hold reads as 'other', so no free text, reviewer or note reaches the summary. An old
-- audit's exclusion has no reason (null). Excluded datasets are off the public surface, so only
-- their owners and privileged readers can ask for the summary at all.
set local lock_timeout = '5s';

create or replace function internal.dataset_audit_summary(p_dataset_id bigint)
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
	), exclusion as (
		select case
			when e.output ->> 'reason' is null then null
			when e.output ->> 'reason' = any (array['blurry', 'no_trees', 'artifacts', 'not_rgb', 'broken_ortho', 'too_dark'])
				then e.output ->> 'reason'
			else 'other'
		end as reason
		from audit.evaluation_decisions e
		where e.dataset_id = p_dataset_id and e.decision = 'exclude'
	)
	select jsonb_build_object(
		'review_required', r.review_required,
		'evaluation_decision', r.evaluation_decision,
		'evaluation_reason', (select reason from exclusion),
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
