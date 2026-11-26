-- Audit Review: checks report outputs, only the dataset evaluation keeps a verdict.
--
-- - audit.assessments gets `output`, what a check or a reviewer reports (cog_issue and
--   thumbnail_issue of the dataset evaluation, a reviewer's georeferencing status or
--   date replacement). verdict stays required where it is the answer: the dataset
--   evaluation and every crop. A reviewer's date override needs a note.
-- - The duplicate check is gone: audit.image_hashes, audit.duplicate_candidates and the
--   hash write in audit.store_dataset_evaluation.
-- - The rows imported from the saved audits (imported_from = 'dataset_audit') are
--   replaced by the old evaluation decisions only: exclude_completely as major,
--   no_issues and ready as ok (fixable_issues stays out), marked 'legacy_audit', dated
--   by the audit and kept also without an auditor.
-- - One owner of the evaluation decision, audit.evaluation_decisions: ok or exclude (no
--   "fix" any more). The latest native reviewer row, else a legacy ok, else the current run's
--   rule rows when they decide, else a legacy exclusion. The earlier audits excluded for
--   reasons the evaluation does not count, so a legacy exclusion holds only until the
--   evaluation decides.
-- - A crop answer on a prediction layer, a reviewer's or a model's, can be ambiguous (20261117135900).
-- - audit.is_dataset_excluded and audit.excluded_dataset_ids: the decision is exclude.
--   They are the only reason a dataset leaves the public surface (next migration).
-- - The AOI stage records its model in v2_aois.model_version.
-- See docs/audit-checks.md.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- No duplicate check
-- ---------------------------------------------------------------------------

drop function audit.duplicate_candidates(bigint, bigint, text, integer, real);
drop table audit.image_hashes;

-- ---------------------------------------------------------------------------
-- Assessments: output, verdict where it is the answer, legacy rows without auditor
-- ---------------------------------------------------------------------------

alter table audit.assessments
	alter column verdict drop not null,
	add column output jsonb check (output is null or jsonb_typeof(output) = 'object'),
	add constraint assessments_verdict_required
		check (verdict is not null or (check_key <> 'dataset_evaluation' and crop_id is null)),
	-- ambiguous is an answer on a crop's prediction layer, a person's or a model's
	add constraint assessments_ambiguous_check check (
		verdict is distinct from 'ambiguous' or (crop_id is not null and layer in ('deadwood', 'forest_cover'))
	),
	drop constraint assessments_check1,
	-- imported rows keep the old record's auditor, which may be unknown
	add constraint assessments_assessor_check check (
		case assessor_kind
			when 'person' then (assessor_user_id is not null or imported_from is not null)
				and model is null and prompt_version is null and raw is null
			else assessor_user_id is null and model is not null and prompt_version is not null and run_id is not null
		end
	);

-- A reviewer who overrides the date check says why. Not validated: earlier answers of the
-- old review page carry no note and stay as history.
alter table audit.assessments add constraint assessments_date_override_note check (
	assessor_kind <> 'person' or check_key <> 'acquisition_date' or imported_from is not null
	or coalesce(length(btrim(reason_text)), 0) > 0
) not valid;

-- The decision and the reviews read these rows; both indexes stay small.
create index assessments_evaluation_idx on audit.assessments (dataset_id)
	where check_key = 'dataset_evaluation' and crop_id is null and assessor_kind <> 'model';
create index assessments_native_person_idx on audit.assessments (dataset_id, check_key)
	where assessor_kind = 'person' and imported_from is null;

delete from audit.assessments where imported_from = 'dataset_audit';

insert into audit.assessments (check_key, dataset_id, layer, assessor_kind, assessor_user_id, verdict, details,
	imported_from, created_at)
select 'dataset_evaluation', a.dataset_id, 'image', 'person', a.audited_by,
	case a.final_assessment when 'exclude_completely' then 'major' else 'ok' end::audit.verdict,
	jsonb_build_object('final_assessment', a.final_assessment), 'legacy_audit', a.audit_date
from public.dataset_audit_legacy a
where a.final_assessment in ('exclude_completely', 'no_issues', 'ready')
	and not exists (
		select 1 from audit.assessments x
		where x.imported_from = 'legacy_audit' and x.dataset_id = a.dataset_id
	);

-- Views over the rows: the new column, and no special case for imported rows any more.
create or replace view audit.current_assessments
with (security_invoker = true)
as
select distinct on (a.check_key, a.dataset_id, a.crop_id, a.layer, a.assessor) a.*
from audit.current_runs c
join audit.runs r on r.id = c.run_id
join audit.assessments a on a.dataset_id = c.dataset_id and a.check_key = c.check_key
	and a.assessor_kind <> 'person'
	and (a.run_id = c.run_id or (a.run_id = r.source_run_id and a.assessor_kind = 'model'))
order by a.check_key, a.dataset_id, a.crop_id, a.layer, a.assessor, a.created_at desc, a.id desc;

create or replace view audit.latest_assessments
with (security_invoker = true)
as
select distinct on (check_key, dataset_id, crop_id, layer, assessor) *
from audit.assessments
order by check_key, dataset_id, crop_id, layer, assessor, created_at desc, id desc;

-- What a dataset evaluation run judged, in one transaction (as before, without the hash).
-- p_result: ortho_sha256, crops, images and assessments (dataset level, layer image, each
-- with an optional output); see processor/src/dataset_evaluation_v1/check.py store_payload.
create or replace function audit.store_dataset_evaluation(p_run_id bigint, p_result jsonb)
returns bigint[]
language plpgsql set search_path = ''
as $$
declare
	v_run audit.runs;
	v_sha text := p_result ->> 'ortho_sha256';
	v_crop_ids bigint[] := '{}';
	v_crop jsonb;
	v_id bigint;
begin
	select * into v_run from audit.runs where id = p_run_id for update;
	if not found then
		raise exception 'Run % does not exist or is not visible', p_run_id using errcode = 'P0002';
	end if;
	if v_run.check_key <> 'dataset_evaluation' or v_run.source_run_id is not null then
		raise exception 'Run % is not a dataset evaluation run that calls the models', p_run_id using errcode = '22023';
	end if;
	if v_run.status not in ('queued', 'running') then
		raise exception 'Run % is already %', p_run_id, v_run.status using errcode = '55000';
	end if;

	-- Crops are per ortho: a rerun on the same ortho finds its crops again. A crop on the
	-- 10 cm CLIP grid is keyed by its window, so a crop another check already stored
	-- (prediction quality) joins the evaluation set instead of being duplicated.
	for v_crop in select value from jsonb_array_elements(coalesce(p_result -> 'crops', '[]'::jsonb)) loop
		if jsonb_typeof(v_crop -> 'pixel_window') = 'array' then
			insert into audit.crops (dataset_id, ortho_sha256, crop_sets, pixel_x0, pixel_y0, pixel_x1, pixel_y1,
				geometry, mpp, size_px, selection)
			values (
				v_run.dataset_id, v_sha, array['evaluation'],
				(v_crop -> 'pixel_window' ->> 0)::integer, (v_crop -> 'pixel_window' ->> 1)::integer,
				(v_crop -> 'pixel_window' ->> 2)::integer, (v_crop -> 'pixel_window' ->> 3)::integer,
				public.st_setsrid(public.st_geomfromgeojson(v_crop ->> 'geometry'), 4326),
				(v_crop ->> 'mpp')::real, (v_crop ->> 'size_px')::integer,
				jsonb_build_object('evaluation', v_crop -> 'selection')
			)
			on conflict (dataset_id, ortho_sha256, pixel_x0, pixel_y0, pixel_x1, pixel_y1)
			do update set
				crop_sets = (select array_agg(distinct s order by s) from unnest(audit.crops.crop_sets || excluded.crop_sets) s),
				selection = excluded.selection || audit.crops.selection
			returning id into v_id;
		else
			insert into audit.crops (dataset_id, ortho_sha256, crop_sets, geometry, mpp, size_px, selection)
			values (
				v_run.dataset_id, v_sha, array['evaluation'],
				public.st_setsrid(public.st_geomfromgeojson(v_crop ->> 'geometry'), 4326),
				(v_crop ->> 'mpp')::real, (v_crop ->> 'size_px')::integer,
				jsonb_build_object('evaluation', v_crop -> 'selection')
			)
			on conflict (dataset_id, ortho_sha256, md5(geometry::text)) where pixel_x0 is null
			do update set
				crop_sets = (select array_agg(distinct s order by s) from unnest(audit.crops.crop_sets || excluded.crop_sets) s),
				selection = excluded.selection || audit.crops.selection
			returning id into v_id;
		end if;
		v_crop_ids := v_crop_ids || v_id;
	end loop;

	insert into audit.images (dataset_id, ortho_sha256, crop_id, kind, storage_path, content_type, width, height, mpp, bytes, sha256)
	select v_run.dataset_id, v_sha, v_crop_ids[(i ->> 'crop_index')::integer], i ->> 'kind', i ->> 'storage_path',
		i ->> 'content_type', (i ->> 'width')::integer, (i ->> 'height')::integer, (i ->> 'mpp')::real,
		(i ->> 'bytes')::integer, i ->> 'sha256'
	from jsonb_array_elements(coalesce(p_result -> 'images', '[]'::jsonb)) i
	-- one image per ortho, crop and kind: a rerun keeps the stored row (and the first
	-- overview); the run's evidence names the files it judged
	on conflict (dataset_id, ortho_sha256, crop_id, label_id, kind) do nothing;

	insert into audit.assessments (check_key, dataset_id, run_id, layer, assessor_kind, model, prompt_version,
		verdict, major_likelihood, modes, details, output, raw)
	select 'dataset_evaluation', v_run.dataset_id, p_run_id, 'image', (a ->> 'assessor_kind')::audit.assessor_kind,
		a ->> 'model', a ->> 'prompt_version', (a ->> 'verdict')::audit.verdict, (a ->> 'major_likelihood')::real,
		coalesce(a -> 'modes', '{}'::jsonb), coalesce(a -> 'details', '{}'::jsonb), nullif(a -> 'output', 'null'::jsonb),
		nullif(a -> 'raw', 'null'::jsonb)
	from jsonb_array_elements(p_result -> 'assessments') a;

	-- the crops this run judged, in the order of p_result.crops
	return v_crop_ids;
end;
$$;

-- ---------------------------------------------------------------------------
-- The evaluation decision and the exclusion
-- ---------------------------------------------------------------------------

-- One row per dataset with an evaluation answer, decision ok or exclude. Priority:
--   1. the latest native reviewer row (a reviewer's unsure is not an answer and is skipped)
--   2. a legacy ok
--   3. the current run's rule rows when they decide (the worst verdict counts)
--   4. a legacy exclusion: it holds only until the evaluation decides
--   5. the current run's undecided rule rows (unsure): no decision, the dataset needs review
-- major is exclude; ok, and the minor ("keep, fix") of earlier rules and reviewers, is ok.
-- Filtered on dataset_id, the planner reads only that dataset's rows.
create view audit.evaluation_decisions
with (security_invoker = true)
as
with rule as (
	select distinct on (a.dataset_id) a.*
	from audit.current_runs c
	join audit.assessments a on a.run_id = c.run_id and a.dataset_id = c.dataset_id
	where c.check_key = 'dataset_evaluation' and a.check_key = 'dataset_evaluation'
		and a.assessor_kind = 'rule' and a.crop_id is null
	order by a.dataset_id, array_position(array['major', 'unsure', 'minor', 'ok']::audit.verdict[], a.verdict),
		a.created_at desc, a.id desc
), answers as (
	select a.*, case when a.imported_from is null then 1 when a.verdict = 'major' then 4 else 2 end as priority
	from audit.assessments a
	where a.check_key = 'dataset_evaluation' and a.crop_id is null and a.assessor_kind = 'person'
		and a.verdict <> 'unsure'
	union all
	select r.*, case when r.verdict = 'unsure' then 5 else 3 end
	from rule r
)
select distinct on (dataset_id)
	dataset_id,
	case when verdict = 'major' then 'exclude' when verdict in ('ok', 'minor') then 'ok' end as decision,
	case
		when verdict = 'unsure' then null
		when assessor_kind = 'rule' then 'check'
		when imported_from is null then 'reviewer'
		else 'legacy'
	end as source,
	verdict,
	output,
	created_at as decided_at
from answers
order by dataset_id, priority, created_at desc, id desc;

-- Narrow and owner-run, so row policies and the public surface can ask without seeing the
-- assessments (docs/audit-checks.md "Exclusion").
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
-- Grants
-- ---------------------------------------------------------------------------

grant select on audit.evaluation_decisions to authenticated, analyst;
grant all on audit.evaluation_decisions to service_role;
