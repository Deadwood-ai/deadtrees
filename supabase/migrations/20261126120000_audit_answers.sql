-- Audit data model rewrite (DT-1606): the audit stores answers and works out results.
--
-- Models and people each get one table per level (docs/audit-checks.md):
--   dataset_vlm_judgements  a model's answer about a whole dataset in a run
--   tile_vlm_judgements     a model's answer about one tile and layer in a run
--   dataset_human_reviews   a person's answer about a whole dataset, per check
--   tile_human_reviews      a person's answer about one tile and layer
-- A check version keeps what the models are asked; how their answers turn into results
-- moves to audit.check_rules, switched on per version. audit.crops becomes audit.tiles,
-- keyed by its window alone, so a tile and its reviews carry over to a rerun. The
-- current-run pointers become the view audit.current_runs. A benchmark is the
-- in_benchmark tick on a person's review: the benchmark tables, versions, freezing and
-- split go, and so do the check modes, the duplicate check and the pilot georeferencing
-- runs (v2_georef_checks is the record).
--
-- audit.assessments moves over in this one transaction:
--   model rows   -> the VLM judgement tables, one per run and judge (and tile and layer).
--                   An unsure verdict, or a failed m0 gate on a tile, is not_assessable.
--                   A rule-only run (source_run_id) gets its source run's answers.
--   rule rows    -> dropped: the rules are worked out from the answers. The dataset
--                   evaluation's band check and empty COG move into the run's evidence.
--   person rows  -> the human review tables (the DT-1272 gold labels included); a failed
--                   m0 gate is not_assessable on both layers. Rows imported from the saved
--                   audits are dropped: the saved audits become audit.legacy_decisions.
--   benchmarks   -> the newest review of every labeled member of the open version (else
--                   the newest frozen one) gets the tick; members without a label go.
-- Before anything is dropped, the view audit.current_runs must pick the same run as the
-- pointer table for every dataset and check, or the migration stops.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Readers of what changes
-- ---------------------------------------------------------------------------

drop view audit.review_queue;
drop view audit.disagreements;
drop view audit.current_assessments;
drop view audit.latest_assessments;

-- 'unsure' goes: a model's "can't assess" and a person's "can't tell" are not_assessable,
-- and ambiguous is an answer of its own. The old type stays until its rows are copied.
alter type audit.verdict rename to verdict_v1;
create type audit.verdict as enum ('ok', 'minor', 'major', 'ambiguous', 'not_assessable');
create type audit.decision as enum ('keep', 'exclude');

-- Rows nobody changes after the insert (the VLM judgements); versions and rules change
-- only by being switched on or off.
create function internal.guard_audit_switch()
returns trigger
language plpgsql set search_path = ''
as $$
begin
	if (to_jsonb(new) - 'is_active' - 'activated_at') is distinct from (to_jsonb(old) - 'is_active' - 'activated_at') then
		raise exception 'Only is_active and activated_at of % change; add a new row instead', tg_table_name
			using errcode = '55000';
	end if;
	return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Check outputs computed from the v2 tables (unchanged rules)
-- ---------------------------------------------------------------------------

-- Georeferencing output, rules georef-rules-v1 (docs/georef-check.md):
--   estimated     the deciding references agree; offset_m is their median p90
--   not_passed    a coordinate looks lost (Poor, gross)
--   no_reference  no reference qualified
--   needs_review  references qualified but none decides, or they conflict; offset_m is
--                 the p90 of the best supported qualified reference, as evidence
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
--   replace  the advice: a reason and a confident estimate, one mode and an 80% range of
--            at most 90 days
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

-- What a person's dataset review is given on, now: the ortho's sha256 for the dataset
-- evaluation and georeferencing, the date estimate's advice ('replace' or 'keep') for the
-- acquisition date. A review whose key differs from this is out of date (stale).
create function internal.audit_evidence_key(p_dataset_id bigint, p_check_key text)
returns text
language sql stable security definer set search_path = ''
as $$
	select case p_check_key
		when 'acquisition_date' then (
			select case when (audit.acquisition_date_output_v1(e) ->> 'replace')::boolean then 'replace' else 'keep' end
			from public.v2_acquisition_date_estimates e
			where e.dataset_id = p_dataset_id)
		else (select o.sha256 from public.v2_orthos o where o.dataset_id = p_dataset_id)
	end;
$$;
revoke all on function internal.audit_evidence_key(bigint, text) from public, anon;
grant execute on function internal.audit_evidence_key(bigint, text) to authenticated, service_role, analyst;

-- ---------------------------------------------------------------------------
-- Versions and their rules
-- ---------------------------------------------------------------------------

drop trigger stamp_audit_check_version on audit.check_versions;
drop function internal.stamp_audit_check_version();
drop policy "Audit worker registers check versions" on audit.check_versions;
drop policy "Operators switch check mode and active version" on audit.check_versions;

-- How a version's answers turn into results: the deciding judge (a name prefix), the
-- thresholds. One active set per version; switching sets re-works every result of the
-- version at once, without a model call.
create table audit.check_rules (
	id bigint generated by default as identity primary key,
	version_id bigint not null references audit.check_versions (id) on delete cascade,
	name text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
	config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
	is_active boolean not null default false,
	activated_at timestamptz,
	created_at timestamptz not null default now(),
	unique (version_id, name)
);
create unique index check_rules_one_active_idx on audit.check_rules (version_id) where is_active;
create trigger guard_audit_check_rules
before update on audit.check_rules
for each row execute function internal.guard_audit_switch();

-- Every version keeps the results it has: prediction quality reads the deciding model's
-- tile answers (Haiku, as the Audit Review did), with the version's own thresholds kept for
-- reference. The dataset evaluation's earlier rules (v1, v2: the models' mean and spread, the
-- duplicate check) are not worked out again: "call": "recorded" reads the call each run's
-- rule recorded (runs.evidence.rule, below), so every dataset keeps its result until an
-- operator switches on rules with a decider or the dataset is rerun. Its band check
-- excludes at 90, as its rule did.
insert into audit.check_rules (version_id, name, config, is_active, activated_at, created_at)
select v.id, 'rules-v1',
	case v.check_key
		when 'dataset_evaluation' then '{"call": "recorded", "band_major_at": 90}'::jsonb
		when 'prediction_quality' then '{"decider": "haiku"}'::jsonb
		else '{}'::jsonb
	end || coalesce(v.config -> 'rule_config', '{}'::jsonb),
	true, v.created_at, v.created_at
from audit.check_versions v
where v.check_key <> 'georef';

alter table audit.check_versions add column activated_at timestamptz;
update audit.check_versions
set activated_at = case when is_active then updated_at end,
	config = config - 'rule_config';
alter table audit.check_versions
	drop column mode,
	drop column updated_at,
	drop column updated_by;
drop type audit.check_mode;
create trigger guard_audit_check_version
before update on audit.check_versions
for each row execute function internal.guard_audit_switch();

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------

-- Benchmark runs never counted; there is no benchmark queue any more.
delete from audit.runs where queue = 'benchmark';
alter table audit.runs drop constraint runs_queue_check,
	add constraint runs_queue_check check (queue in ('upload', 'backfill', 'manual'));
alter table audit.runs rename column check_version_id to version_id;
drop policy "Audit worker creates runs" on audit.runs;
drop policy "Audit worker updates runs" on audit.runs;

-- Coverage and cost are evidence of the run. A rule-only run judged its source run's
-- inputs. The dataset evaluation's band check, empty COG and dataset rule were rule rows;
-- the rules read them from the evidence now (evidence.rule is the call the run's rule
-- recorded: verdict, reason, fix_flags, summary, version).
update audit.runs
set evidence = evidence || jsonb_strip_nulls(jsonb_build_object(
	'coverage', nullif(coverage, '{}'::jsonb), 'cost', nullif(cost, '{}'::jsonb)));
update audit.runs r
set inputs = s.inputs
from audit.runs s
where s.id = r.source_run_id;

with checks as (
	select distinct on (r.id, a.model) r.id as run_id, a.id, a.model, a.verdict, a.major_likelihood, a.details
	from audit.runs r
	join audit.assessments a on a.run_id in (r.id, r.source_run_id) and a.check_key = 'dataset_evaluation'
		and a.assessor_kind = 'rule' and a.crop_id is null
		and a.model in ('band_check', 'empty_cog', 'dataset-evaluation-rule')
	where r.check_key = 'dataset_evaluation'
	order by r.id, a.model, a.run_id = r.id desc, a.created_at desc, a.id desc
)
update audit.runs r
set evidence = r.evidence || jsonb_strip_nulls(jsonb_build_object(
	'band_check', (select jsonb_build_object('likelihood', c.major_likelihood, 'verdict', c.verdict, 'details', c.details)
		from checks c where c.run_id = r.id and c.model = 'band_check'),
	'empty', (select true from checks c where c.run_id = r.id and c.model = 'empty_cog' and c.verdict = 'major'),
	'rule', (select jsonb_build_object('verdict', c.verdict, 'reason', c.details ->> 'reason',
			'fix_flags', c.details -> 'fix_flags', 'summary', c.details ->> 'summary', 'version', c.model || '/' || a.prompt_version)
		from checks c join audit.assessments a on a.id = c.id where c.run_id = r.id and c.model = 'dataset-evaluation-rule')))
where r.check_key = 'dataset_evaluation'
	and exists (select 1 from checks c where c.run_id = r.id);

alter table audit.runs add constraint runs_id_dataset_id_key unique (id, dataset_id);

-- ---------------------------------------------------------------------------
-- Tiles (were crops) and images
-- ---------------------------------------------------------------------------

drop trigger append_only_audit_crop_sets on audit.crops;
drop function internal.append_only_audit_crop_sets();
drop policy "Audit worker stores crops" on audit.crops;
drop policy "Audit worker adds crops to sets" on audit.crops;
drop policy "Audit worker stores images" on audit.images;
alter table audit.crops rename to tiles;
alter index audit.crops_pkey rename to tiles_pkey;
alter index audit.crops_id_dataset_id_key rename to tiles_id_dataset_id_key;
alter index audit.crops_geometry_idx rename to tiles_geometry_idx;
alter table audit.tiles rename constraint crops_check to tiles_window_check;
alter table audit.images rename column crop_id to tile_id;
alter table audit.images rename column label_id to prediction_label_id;
alter index audit.images_crop_idx rename to images_tile_idx;

-- A tile is its window and its footprint on the ground (off the grid, its footprint alone),
-- whatever ortho it was cut from. A window is a pixel box of one ortho's grid, so after the
-- ortho is rewritten the same window is the same tile only where the footprint did not
-- move: crops with the same window and footprint on several orthos become one tile, the
-- oldest; a moved footprint stays a tile of its own.
create temporary table tile_map on commit drop as
select c.id as crop_id,
	min(c.id) over (partition by c.dataset_id, c.pixel_x0, c.pixel_y0, c.pixel_x1, c.pixel_y1, md5(c.geometry::text))
		as tile_id
from audit.tiles c;
create unique index on tile_map (crop_id);

-- The runs a crop was judged in: its model rows (a rule-only run's from its source run),
-- or the crops the dataset evaluation names in its evidence.
create temporary table judged_crops on commit drop as
select distinct r.id as run_id, x.crop_id
from audit.runs r
cross join lateral (
	select a.crop_id from audit.assessments a
	where a.run_id = coalesce(r.source_run_id, r.id) and a.assessor_kind = 'model' and a.crop_id is not null
	union
	select (c #>> '{}')::bigint
	from audit.runs e
	cross join jsonb_array_elements(case when jsonb_typeof(e.evidence -> 'judged' -> 'crop_ids') = 'array'
		then e.evidence -> 'judged' -> 'crop_ids' else '[]'::jsonb end) c
	where e.id = coalesce(r.source_run_id, r.id)
) x
where r.check_key <> 'georef';

-- Images belong to the runs that showed them: the same ortho, and the tile judged in the
-- run (an overlay also of the run's prediction), or the overview and thumbnail of a dataset
-- evaluation. An image several runs showed is stored once per run; images no run showed
-- (the DT-1272 gold crops) keep no run.
alter table audit.images add column run_id bigint;
create temporary table image_runs on commit drop as
select i.id as image_id, r.id as run_id, row_number() over (partition by i.id order by r.id) as n
from audit.images i
join audit.runs r on r.dataset_id = i.dataset_id and r.inputs ->> 'ortho_sha256' = i.ortho_sha256
	and r.check_key <> 'georef'
where case
	when i.tile_id is null then r.check_key = 'dataset_evaluation'
	else exists (select 1 from judged_crops j where j.run_id = r.id and j.crop_id = i.tile_id)
		and (i.prediction_label_id is null
			or i.prediction_label_id = (r.inputs -> 'label_ids' ->> case i.kind
				when 'deadwood_overlay' then 'deadwood' when 'forest_cover_overlay' then 'forest_cover' end)::bigint)
end;

alter table audit.images drop constraint images_dataset_id_ortho_sha256_crop_id_label_id_kind_key;
update audit.images i set run_id = x.run_id from image_runs x where x.image_id = i.id and x.n = 1;
insert into audit.images (dataset_id, run_id, tile_id, prediction_label_id, kind, storage_path, content_type,
	width, height, mpp, bytes, sha256, ortho_sha256, created_at)
select i.dataset_id, x.run_id, i.tile_id, i.prediction_label_id, i.kind, i.storage_path, i.content_type,
	i.width, i.height, i.mpp, i.bytes, i.sha256, i.ortho_sha256, i.created_at
from image_runs x
join audit.images i on i.id = x.image_id
where x.n > 1;
update audit.images i set tile_id = m.tile_id from tile_map m where m.crop_id = i.tile_id and m.tile_id <> m.crop_id;

-- ---------------------------------------------------------------------------
-- The answer tables
-- ---------------------------------------------------------------------------

create table audit.dataset_vlm_judgements (
	id bigint generated by default as identity primary key,
	run_id bigint not null,
	dataset_id bigint not null references public.v2_datasets (id) on delete cascade,
	judge text not null check (judge ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),   -- model name, e.g. 'haiku-5.5'
	verdict audit.verdict not null,
	likelihood real check (likelihood between 0 and 100),   -- of major (exclude)
	cog_issue boolean,
	thumbnail_issue boolean,
	exclude_reason text,
	summary text,
	raw jsonb not null default '{}'::jsonb check (jsonb_typeof(raw) = 'object'),   -- the parsed answer
	created_at timestamptz not null default now(),
	foreign key (run_id, dataset_id) references audit.runs (id, dataset_id) on delete cascade,
	unique (run_id, judge),
	check (verdict <> 'ambiguous')
);

create table audit.tile_vlm_judgements (
	id bigint generated by default as identity primary key,
	run_id bigint not null,
	dataset_id bigint not null references public.v2_datasets (id) on delete cascade,
	tile_id bigint not null,
	layer text not null check (layer in ('deadwood', 'forest_cover')),
	judge text not null check (judge ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
	verdict audit.verdict not null,
	likelihood real check (likelihood between 0 and 100),   -- of a major error in the layer
	-- by failure mode: {"m1_dead_missed": {"likelihood": 80, "area_pct": 12}}
	problems jsonb not null default '{}'::jsonb check (jsonb_typeof(problems) = 'object'),
	summary text,
	raw jsonb not null default '{}'::jsonb check (jsonb_typeof(raw) = 'object'),   -- the parsed answer, its errors
	created_at timestamptz not null default now(),
	foreign key (run_id, dataset_id) references audit.runs (id, dataset_id) on delete cascade,
	foreign key (tile_id, dataset_id) references audit.tiles (id, dataset_id) on delete cascade,
	unique (run_id, tile_id, layer, judge)
);
create index tile_vlm_judgements_tile_idx on audit.tile_vlm_judgements (tile_id);

create trigger reject_dataset_vlm_judgement_update
before update on audit.dataset_vlm_judgements
for each row execute function internal.reject_audit_row_update();
create trigger reject_tile_vlm_judgement_update
before update on audit.tile_vlm_judgements
for each row execute function internal.reject_audit_row_update();

-- A person's answer about a dataset, one column set per check. A new answer is a new row
-- and the newest counts while its evidence_key matches the dataset's
-- (internal.audit_evidence_key); in_benchmark makes it a benchmark label.
create table audit.dataset_human_reviews (
	id bigint generated by default as identity primary key,
	dataset_id bigint not null references public.v2_datasets (id) on delete cascade,
	check_key text not null references audit.checks (key)
		check (check_key in ('dataset_evaluation', 'georef', 'acquisition_date')),
	evidence_key text,   -- set on insert from the dataset's current state, never by the client
	decision audit.decision,
	exclude_reason text check (length(exclude_reason) <= 200),
	cog_issue boolean,
	thumbnail_issue boolean,
	georef_status text check (georef_status in ('passed', 'not_passed')),   -- passed: within 15 m
	date_replace boolean,   -- use the estimated date instead of the recorded one
	note text check (length(note) <= 2000),
	in_benchmark boolean not null default false,
	reviewed_by uuid default auth.uid() references auth.users (id) on delete set null,
	created_at timestamptz not null default now(),
	check (case check_key
		when 'dataset_evaluation' then decision is not null and georef_status is null and date_replace is null
			and (exclude_reason is null or decision = 'exclude')
		when 'georef' then georef_status is not null and decision is null and date_replace is null
			and exclude_reason is null and cog_issue is null and thumbnail_issue is null
		else date_replace is not null and decision is null and georef_status is null
			and exclude_reason is null and cog_issue is null and thumbnail_issue is null
	end),
	check (not in_benchmark or check_key = 'dataset_evaluation')
);
create index dataset_human_reviews_dataset_idx on audit.dataset_human_reviews (dataset_id, check_key, created_at desc);
create index dataset_human_reviews_benchmark_idx on audit.dataset_human_reviews (dataset_id) where in_benchmark;

-- A person's answer about one tile and layer, on the prediction it showed. No foreign key
-- to the label: a prediction rerun deletes it, and the review stays as history (it no
-- longer matches the run's label, so it stops counting).
create table audit.tile_human_reviews (
	id bigint generated by default as identity primary key,
	dataset_id bigint not null references public.v2_datasets (id) on delete cascade,
	tile_id bigint not null,
	layer text not null check (layer in ('deadwood', 'forest_cover')),
	prediction_label_id bigint,
	verdict audit.verdict not null,
	problems jsonb not null default '{}'::jsonb check (jsonb_typeof(problems) = 'object'),   -- {"m1_dead_missed": true}
	note text check (length(note) <= 2000),
	in_benchmark boolean not null default false,
	reviewed_by uuid default auth.uid() references auth.users (id) on delete set null,
	created_at timestamptz not null default now(),
	foreign key (tile_id, dataset_id) references audit.tiles (id, dataset_id) on delete cascade
);
create index tile_human_reviews_target_idx on audit.tile_human_reviews (dataset_id, tile_id, layer, created_at desc);
create index tile_human_reviews_benchmark_idx on audit.tile_human_reviews (layer, tile_id) where in_benchmark;

-- The saved manual audits' keep or exclude (public.dataset_audit), read only by
-- audit.evaluation_decisions until the datasets are reassessed. "Fixable issues" was no
-- decision and stays out.
create table audit.legacy_decisions (
	dataset_id bigint primary key references public.v2_datasets (id) on delete cascade,
	decision audit.decision not null,
	reason text,
	decided_at timestamptz not null
);

-- ---------------------------------------------------------------------------
-- Copy the answers
-- ---------------------------------------------------------------------------

-- Model answers about a dataset (the dataset evaluation), newest per run and judge.
insert into audit.dataset_vlm_judgements (run_id, dataset_id, judge, verdict, likelihood, cog_issue, thumbnail_issue,
	exclude_reason, summary, raw, created_at)
select distinct on (r.id, a.model)
	r.id, r.dataset_id, a.model,
	(case a.verdict when 'unsure' then 'not_assessable' else a.verdict::text end)::audit.verdict,
	a.major_likelihood,
	(a.modes -> 'cog_issue' ->> 'likelihood')::real >= coalesce((cr.config ->> 'fix_at')::real, 50),
	(a.modes -> 'thumbnail_issue' ->> 'likelihood')::real >= coalesce((cr.config ->> 'fix_at')::real, 50),
	nullif(a.details ->> 'reason', ''),
	nullif(a.details ->> 'summary', ''),
	a.details || jsonb_strip_nulls(jsonb_build_object('modes', a.modes, 'reply', a.raw)),
	a.created_at
from audit.runs r
join audit.assessments a on a.run_id = coalesce(r.source_run_id, r.id) and a.check_key = 'dataset_evaluation'
	and a.assessor_kind = 'model' and a.crop_id is null
left join audit.check_rules cr on cr.version_id = r.version_id and cr.is_active
where r.check_key = 'dataset_evaluation'
order by r.id, a.model, a.created_at desc, a.id desc;

-- Model answers about a tile and layer, newest per run, tile, layer and judge. A judge that
-- could not assess the tile (m0 gate) is not_assessable on both layers.
with gate as (
	select distinct on (a.run_id, a.crop_id, a.model) a.run_id, a.crop_id, a.model, a.verdict = 'ok' as assessable,
		a.raw, a.created_at
	from audit.assessments a
	where a.check_key = 'prediction_quality' and a.assessor_kind = 'model' and a.crop_id is not null and a.layer = 'image'
	order by a.run_id, a.crop_id, a.model, a.created_at desc, a.id desc
), answers as (
	select distinct on (a.run_id, a.crop_id, a.layer, a.model) a.*
	from audit.assessments a
	where a.check_key = 'prediction_quality' and a.assessor_kind = 'model' and a.crop_id is not null
		and a.layer in ('deadwood', 'forest_cover')
	order by a.run_id, a.crop_id, a.layer, a.model, a.created_at desc, a.id desc
)
insert into audit.tile_vlm_judgements (run_id, dataset_id, tile_id, layer, judge, verdict, likelihood, problems,
	summary, raw, created_at)
select r.id, r.dataset_id, m.tile_id, a.layer, a.model,
	(case when not coalesce(g.assessable, true) or a.verdict = 'unsure' then 'not_assessable'
		else a.verdict::text end)::audit.verdict,
	a.major_likelihood, a.modes, nullif(a.details ->> 'summary', ''),
	a.details || jsonb_strip_nulls(jsonb_build_object('reply', coalesce(a.raw, g.raw))),
	a.created_at
from audit.runs r
join answers a on a.run_id = coalesce(r.source_run_id, r.id)
join tile_map m on m.crop_id = a.crop_id
left join gate g on g.run_id = a.run_id and g.crop_id = a.crop_id and g.model = a.model
where r.check_key = 'prediction_quality'
union all
select r.id, r.dataset_id, m.tile_id, l.layer, g.model, 'not_assessable', null, '{}'::jsonb, null,
	jsonb_strip_nulls(jsonb_build_object('reply', g.raw)), g.created_at
from audit.runs r
join gate g on g.run_id = coalesce(r.source_run_id, r.id) and not g.assessable
join tile_map m on m.crop_id = g.crop_id
cross join (values ('deadwood'), ('forest_cover')) l (layer)
where r.check_key = 'prediction_quality'
	and not exists (
		select 1 from answers a
		where a.run_id = g.run_id and a.crop_id = g.crop_id and a.model = g.model and a.layer = l.layer
	);

-- People's answers about a dataset. An unsure answer was no answer. The review counts on
-- the ortho of the run it was given on, else on the current ortho; a date answer on the
-- current advice, so every review that counts today keeps counting.
insert into audit.dataset_human_reviews (dataset_id, check_key, evidence_key, decision, exclude_reason, cog_issue,
	thumbnail_issue, georef_status, date_replace, note, reviewed_by, created_at)
select a.dataset_id, a.check_key,
	case when a.check_key = 'acquisition_date' then internal.audit_evidence_key(a.dataset_id, a.check_key)
		else coalesce(nullif(coalesce(src.inputs, run.inputs) ->> 'ortho_sha256', ''),
			internal.audit_evidence_key(a.dataset_id, a.check_key))
	end,
	case when a.check_key = 'dataset_evaluation' then
		(case when a.verdict = 'major' then 'exclude' else 'keep' end)::audit.decision end,
	case when a.check_key = 'dataset_evaluation' and a.verdict = 'major' then
		left(coalesce(a.reason_code, a.details ->> 'reason'), 200) end,
	case when a.check_key = 'dataset_evaluation' and a.verdict <> 'major' and jsonb_typeof(a.details -> 'fix_flags') = 'array'
		then (a.details -> 'fix_flags') ? 'cog_issue' end,
	case when a.check_key = 'dataset_evaluation' and a.verdict <> 'major' and jsonb_typeof(a.details -> 'fix_flags') = 'array'
		then (a.details -> 'fix_flags') ? 'thumbnail_issue' end,
	case when a.check_key = 'georef' then case when a.verdict = 'major' then 'not_passed' else 'passed' end end,
	case when a.check_key = 'acquisition_date' then a.verdict = 'major' end,
	left(nullif(btrim(concat_ws(': ', case when a.check_key <> 'dataset_evaluation' then a.reason_code end, a.reason_text)), ''), 2000),
	a.assessor_user_id, a.created_at
from audit.assessments a
left join audit.runs run on run.id = a.run_id
left join audit.runs src on src.id = run.source_run_id
where a.assessor_kind = 'person' and a.imported_from is null and a.crop_id is null and a.verdict <> 'unsure'
	and (a.check_key, a.layer) in (('dataset_evaluation', 'image'), ('georef', 'georef'), ('acquisition_date', 'acquisition_date'));

-- People's answers about a tile and layer; unsure is not_assessable, and so is a failed m0
-- gate on both layers the person left without an answer in the same save. problems holds
-- the error types seen (true) and those the person was unsure of ("unsure").
insert into audit.tile_human_reviews (dataset_id, tile_id, layer, prediction_label_id, verdict, problems, note,
	reviewed_by, created_at)
select a.dataset_id, m.tile_id, a.layer, a.label_id,
	(case a.verdict when 'unsure' then 'not_assessable' else a.verdict::text end)::audit.verdict,
	-- the error types the person was unsure of (details.unsure_modes) stay, as "unsure"
	a.modes || coalesce((
		select jsonb_object_agg(u, 'unsure')
		from jsonb_array_elements_text(case when jsonb_typeof(a.details -> 'unsure_modes') = 'array'
			then a.details -> 'unsure_modes' else '[]'::jsonb end) u
		where not a.modes ? u), '{}'::jsonb),
	left(nullif(btrim(concat_ws(': ', a.reason_code, coalesce(a.reason_text, a.details ->> 'note'))), ''), 2000),
	a.assessor_user_id, a.created_at
from audit.assessments a
join tile_map m on m.crop_id = a.crop_id
where a.check_key = 'prediction_quality' and a.assessor_kind = 'person' and a.imported_from is null
	and a.layer in ('deadwood', 'forest_cover')
union all
select g.dataset_id, m.tile_id, l.layer,
	coalesce(
		(run.inputs -> 'label_ids' ->> l.layer)::bigint,
		(select i.prediction_label_id from audit.images i
			where i.tile_id = m.tile_id and i.kind = l.layer || '_overlay' and i.prediction_label_id is not null
			order by i.created_at desc, i.id desc limit 1)),
	'not_assessable', '{}'::jsonb,
	left(nullif(btrim(concat_ws(': ', g.reason_code, coalesce(g.reason_text, g.details ->> 'note'))), ''), 2000),
	g.assessor_user_id, g.created_at
from audit.assessments g
join tile_map m on m.crop_id = g.crop_id
left join audit.runs run on run.id = g.run_id
cross join (values ('deadwood'), ('forest_cover')) l (layer)
where g.check_key = 'prediction_quality' and g.assessor_kind = 'person' and g.imported_from is null
	and g.layer = 'image' and g.verdict <> 'ok'
	and not exists (
		select 1 from audit.assessments a
		where a.crop_id = g.crop_id and a.layer = l.layer and a.assessor_kind = 'person'
			and a.assessor_user_id = g.assessor_user_id and a.created_at = g.created_at
	);

-- Benchmark labels: per check, the members of the open version, else of the newest frozen
-- one. The newest review of each labeled member gets the tick; on a tile, per layer.
create temporary table benchmark_targets on commit drop as
select m.dataset_id, tm.tile_id, b.check_key
from (
	select distinct on (check_key) id, check_key from audit.benchmarks
	order by check_key, frozen_at is null desc, created_at desc, id desc
) b
join audit.benchmark_members m on m.benchmark_id = b.id
left join tile_map tm on tm.crop_id = m.crop_id;

update audit.dataset_human_reviews h
set in_benchmark = true
where h.id in (
	select distinct on (r.dataset_id) r.id
	from audit.dataset_human_reviews r
	join benchmark_targets t on t.dataset_id = r.dataset_id and t.tile_id is null and t.check_key = 'dataset_evaluation'
	where r.check_key = 'dataset_evaluation'
	order by r.dataset_id, r.created_at desc, r.id desc
);
update audit.tile_human_reviews h
set in_benchmark = true
where h.id in (
	select distinct on (r.tile_id, r.layer) r.id
	from audit.tile_human_reviews r
	join benchmark_targets t on t.tile_id = r.tile_id and t.check_key = 'prediction_quality'
	order by r.tile_id, r.layer, r.created_at desc, r.id desc
);

insert into audit.legacy_decisions (dataset_id, decision, reason, decided_at)
select a.dataset_id,
	(case a.final_assessment when 'exclude_completely' then 'exclude' else 'keep' end)::audit.decision,
	nullif(btrim(a.notes), ''), a.audit_date
from public.dataset_audit_legacy a
where a.final_assessment in ('exclude_completely', 'no_issues', 'ready');

-- From now on the dataset's state names what a review is given on.
create function internal.set_audit_evidence_key()
returns trigger
language plpgsql set search_path = ''
as $$
begin
	new.evidence_key := internal.audit_evidence_key(new.dataset_id, new.check_key);
	return new;
end;
$$;
create trigger set_audit_evidence_key
before insert on audit.dataset_human_reviews
for each row execute function internal.set_audit_evidence_key();

-- ---------------------------------------------------------------------------
-- Tiles without the ortho fingerprint; images per run
-- ---------------------------------------------------------------------------

delete from audit.tiles t using tile_map m where m.crop_id = t.id and m.tile_id <> m.crop_id;
alter table audit.tiles
	drop column ortho_sha256,
	drop column crop_sets,
	drop column selection;
-- one key for both kinds: an off-grid tile has no window (all null, equal here)
create unique index tiles_footprint_key on audit.tiles (dataset_id, pixel_x0, pixel_y0, pixel_x1, pixel_y1, md5(geometry::text))
	nulls not distinct;

alter table audit.images
	drop column ortho_sha256,
	add foreign key (run_id, dataset_id) references audit.runs (id, dataset_id) on delete cascade,
	drop constraint images_check1,
	add constraint images_overlay_label_check
		check (kind in ('deadwood_overlay', 'forest_cover_overlay') or prediction_label_id is null);
alter table audit.images rename constraint images_check to images_tile_check;
create unique index images_run_key on audit.images (run_id, tile_id, prediction_label_id, kind) nulls not distinct
	where run_id is not null;
create index images_run_idx on audit.images (run_id);

-- ---------------------------------------------------------------------------
-- The run that counts: a view instead of pointers
-- ---------------------------------------------------------------------------

-- The pilot georeferencing runs and their versions go; v2_georef_checks is the record.
delete from audit.runs where check_key = 'georef';
delete from audit.check_versions where check_key = 'georef';

alter table audit.current_runs rename to current_runs_v1;

-- Per dataset and check, the run whose results count and the rules to read it with: the
-- latest done run of the active version; while a dataset has none yet (its rerun is
-- queued), its latest done run of an older version, read with that version's rules.
create view audit.current_runs
with (security_invoker = true)
as
select distinct on (r.dataset_id, r.check_key)
	r.dataset_id, r.check_key, r.id as run_id, r.version_id, cr.id as rules_id, cr.config as rules,
	r.inputs, r.finished_at, v.is_active as is_active_version
from audit.runs r
join audit.check_versions v on v.id = r.version_id
left join audit.check_rules cr on cr.version_id = r.version_id and cr.is_active
where r.status = 'done'
order by r.dataset_id, r.check_key, v.is_active desc, r.finished_at desc, r.id desc;

do $$
declare
	v_diff text;
begin
	select string_agg(format('%s/%s: pointer %s, view %s', d.dataset_id, d.check_key, d.pointer, d.picked), '; ')
	into v_diff
	from (
		select coalesce(o.dataset_id, n.dataset_id) as dataset_id, coalesce(o.check_key, n.check_key) as check_key,
			o.run_id as pointer, n.run_id as picked
		from audit.current_runs_v1 o
		full join audit.current_runs n on n.dataset_id = o.dataset_id and n.check_key = o.check_key
		where o.run_id is distinct from n.run_id
		order by 1, 2
		limit 50
	) d;
	if v_diff is not null then
		raise exception 'audit.current_runs would pick other runs than the current pointers: %', v_diff
			using errcode = '23514';
	end if;
end
$$;

-- ---------------------------------------------------------------------------
-- What goes
-- ---------------------------------------------------------------------------

drop table audit.current_runs_v1;
drop function internal.reject_benchmark_current_run();

drop function audit.add_benchmark_target(text, bigint, bigint);
drop function audit.remove_benchmark_target(text, bigint, bigint);
drop table audit.benchmark_scores;
drop table audit.benchmark_members;
drop table audit.benchmarks;
drop function audit.benchmark_split(bigint);
drop function internal.guard_audit_benchmark();
drop function internal.guard_audit_benchmark_member();
drop function internal.require_frozen_audit_benchmark();

drop function audit.store_dataset_evaluation(bigint, jsonb);
drop function audit.duplicate_candidates(bigint, bigint, text, integer, real);
drop table audit.image_hashes;

drop table audit.assessments;
drop function internal.reject_model_rows_on_rule_only_runs();
drop type audit.assessor_kind;
drop type audit.verdict_v1;

drop trigger check_audit_rule_only_run on audit.runs;
drop function internal.check_audit_rule_only_run();
alter table audit.runs
	drop column source_run_id,
	drop column coverage,
	drop column cost;
alter table audit.runs drop constraint runs_id_check_key_dataset_id_key;
create index runs_done_idx on audit.runs (dataset_id, check_key, finished_at desc) where status = 'done';

-- The georeferencing check stores only its v2 row (no audit run, no suggestion).
drop function public.store_georef_check(jsonb, jsonb, text);
drop function internal.store_georef_audit_run(bigint, text);
drop function internal.georef_check_version(text, text);

create function public.store_georef_check(p_check jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
	if not internal.is_audit_worker() then
		raise exception 'Only the processor stores georeferencing checks' using errcode = '42501';
	end if;
	insert into public.v2_georef_checks
	-- the column defaults for keys the caller leaves out (populate_record would null them)
	select * from jsonb_populate_record(
		null::public.v2_georef_checks,
		'{"evidence_groups": 0, "support": 0, "edge_support": 0, "used_aoi": false, "reference_evidence": [], "reference_errors": {}, "metadata": {}}'::jsonb
			|| p_check || jsonb_build_object('created_at', now(), 'updated_at', now()))
	on conflict (dataset_id) do update set
		model_version = excluded.model_version,
		rules_version = excluded.rules_version,
		decision = excluded.decision,
		evidence_level = excluded.evidence_level,
		reason = excluded.reason,
		p90_m = excluded.p90_m,
		evidence_groups = excluded.evidence_groups,
		support = excluded.support,
		edge_support = excluded.edge_support,
		used_aoi = excluded.used_aoi,
		reference_evidence = excluded.reference_evidence,
		reference_errors = excluded.reference_errors,
		metadata = excluded.metadata,
		updated_at = excluded.updated_at;
end;
$$;
revoke all on function public.store_georef_check(jsonb) from public, anon;
grant execute on function public.store_georef_check(jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Access: auditors read everything and add their own reviews. The audit worker (the
-- processor account, internal.is_audit_worker) registers versions and rules switched off,
-- creates and updates runs, and stores a run's tiles, images and judgements only through
-- audit.finish_run. Operators switch versions and rules through audit.activate_version and
-- audit.activate_rules.
-- ---------------------------------------------------------------------------

alter table audit.check_rules enable row level security;
alter table audit.dataset_vlm_judgements enable row level security;
alter table audit.tile_vlm_judgements enable row level security;
alter table audit.dataset_human_reviews enable row level security;
alter table audit.tile_human_reviews enable row level security;
alter table audit.legacy_decisions enable row level security;

revoke all on all tables in schema audit from public, anon, authenticated;
grant select on all tables in schema audit to authenticated, analyst;
grant insert (dataset_id, check_key, decision, exclude_reason, cog_issue, thumbnail_issue, georef_status, date_replace,
	note, in_benchmark, reviewed_by) on audit.dataset_human_reviews to authenticated;
grant insert (dataset_id, tile_id, layer, prediction_label_id, verdict, problems, note, in_benchmark, reviewed_by)
	on audit.tile_human_reviews to authenticated;
grant insert (check_key, version, config) on audit.check_versions to authenticated;
grant insert (version_id, name, config) on audit.check_rules to authenticated;
grant insert (check_key, version_id, dataset_id, queue, status, inputs, evidence, error, attempts, started_at, finished_at),
	update (status, inputs, evidence, error, attempts, started_at, finished_at) on audit.runs to authenticated;
grant all on all tables in schema audit to service_role;

do $$
declare
	t text;
begin
	foreach t in array array['check_rules', 'dataset_vlm_judgements', 'tile_vlm_judgements', 'dataset_human_reviews',
		'tile_human_reviews', 'legacy_decisions'] loop
		execute format('create policy "Auditors and the audit worker read" on audit.%I for select to authenticated '
			'using ((select internal.can_read_audit_checks()))', t);
		execute format('create policy analyst_select on audit.%I for select to analyst using (true)', t);
	end loop;
end
$$;

create policy "Audit worker registers check versions" on audit.check_versions
	for insert to authenticated with check ((select internal.is_audit_worker()) and not is_active);
create policy "Audit worker registers check rules" on audit.check_rules
	for insert to authenticated with check ((select internal.is_audit_worker()) and not is_active);
create policy "Audit worker creates runs" on audit.runs
	for insert to authenticated with check ((select internal.is_audit_worker()));
create policy "Audit worker updates runs" on audit.runs
	for update to authenticated using ((select internal.is_audit_worker())) with check ((select internal.is_audit_worker()));

-- An auditor adds their own reviews; a benchmark label (in_benchmark) is an operator's.
create policy "Auditors add their own reviews" on audit.dataset_human_reviews
	for insert to authenticated
	with check (reviewed_by = (select auth.uid())
		and ((select public.can_operate()) or ((select public.can_audit()) and not in_benchmark)));
create policy "Auditors add their own reviews" on audit.tile_human_reviews
	for insert to authenticated
	with check (reviewed_by = (select auth.uid()) and prediction_label_id is not null
		and ((select public.can_operate()) or ((select public.can_audit()) and not in_benchmark)));

comment on table audit.check_rules is 'How a check version''s answers turn into results (docs/audit-checks.md).';
comment on table audit.tiles is 'Square patches of a dataset''s ortho on the CLIP grid that models and people judge.';
comment on table audit.dataset_vlm_judgements is 'A model''s answer about a whole dataset in a run; insert-only.';
comment on table audit.tile_vlm_judgements is 'A model''s answer about one tile and layer in a run; insert-only.';
comment on table audit.dataset_human_reviews is 'A person''s answer about a dataset; the newest non-stale one counts.';
comment on table audit.tile_human_reviews is 'A person''s answer about one tile and layer, on the prediction it showed.';
comment on table audit.legacy_decisions is 'Keep or exclude from the saved manual audits; filled once by the rewrite.';
