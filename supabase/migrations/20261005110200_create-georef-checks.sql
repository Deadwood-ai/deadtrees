-- Georeferencing checks: one row per dataset, replaced when the stage reruns.
--
-- The processor matches the ortho (inside its AOI) against satellite references
-- (Esri World Imagery, dated Esri Wayback captures, and Google / MapTiler /
-- Mapbox when keyed), fits a similarity transform per reference and measures
-- the geodesic offset of the footprint. decision is good (p90 offset < 15 m),
-- poor, or uncertain; evidence_level says how strong the call is:
--   strong        >= 2 independent reference groups agree, broad support,
--                 every p90 clear of the 15 m line
--   qualified     at least one qualified reference decides, not strong
--   gross         no reference matches and the footprint sits on the equator or
--                 prime meridian (lost coordinates)
--   insufficient  no qualified reference (uncertain)
--   conflict      qualified references disagree or flip under holdouts (uncertain)
-- A good/poor call also becomes the is_georeferenced audit suggestion
-- (dataset_audit_suggestions), so a disagreeing saved audit shows up in
-- audit_review_queue. See processor/src/georef_check_v1 and docs/georef-check.md.
create table if not exists public.v2_georef_checks (
  dataset_id bigint primary key references public.v2_datasets (id) on delete cascade,
  model_version text not null,
  rules_version text not null,
  decision text not null check (decision in ('good', 'poor', 'uncertain')),
  evidence_level text not null check (evidence_level in ('strong', 'qualified', 'gross', 'insufficient', 'conflict')),
  reason text not null,
  -- median p90 offset (m) over the deciding references
  p90_m real,
  evidence_groups smallint not null default 0,
  support real not null default 0,
  edge_support real not null default 0,
  used_aoi boolean not null default false,
  -- per reference: provider, group, inliers, support, p50/p90, holdout p90s,
  -- vote, qualified/decides, reason, fitted matrix, up to 200 inlier pairs as
  -- [lon_drone, lat_drone, lon_reference, lat_reference]
  reference_evidence jsonb not null default '[]'::jsonb,
  reference_errors jsonb not null default '{}'::jsonb,
  -- rules, grid, reference zoom / capture date / keyless tile URL, runtime
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((decision = 'uncertain') = (evidence_level in ('insufficient', 'conflict')))
);

create index if not exists v2_georef_checks_decision_idx on public.v2_georef_checks (decision);
create index if not exists v2_georef_checks_rules_version_idx on public.v2_georef_checks (rules_version);

grant select on table public.v2_georef_checks to anon, authenticated;
grant insert, update, delete on table public.v2_georef_checks to authenticated;
grant all on table public.v2_georef_checks to service_role;

alter table public.v2_georef_checks enable row level security;

-- Read access follows dataset visibility, like the acquisition-date estimates.
drop policy if exists "Allow read access to georef checks" on public.v2_georef_checks;
create policy "Allow read access to georef checks"
  on public.v2_georef_checks
  for select
  to public
  using (
    exists (
      select 1
      from public.v2_datasets d
      where d.id = v2_georef_checks.dataset_id
        and (
          d.data_access <> 'private'::access
          or auth.uid() = d.user_id
          or can_view_all_private_data()
          or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
        )
        and (d.archived = false or auth.uid() = d.user_id)
    )
  );

drop policy if exists "Allow processor to write georef checks" on public.v2_georef_checks;
create policy "Allow processor to write georef checks"
  on public.v2_georef_checks
  for all
  to authenticated
  using ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
  with check ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text);

grant select on public.v2_georef_checks to analyst;
drop policy if exists analyst_select on public.v2_georef_checks;
create policy analyst_select on public.v2_georef_checks for select to analyst using (true);

-- Keep the factory stage ordering aware of the new (last) stage.
create or replace function public.factory_stage_position(p_stage text) returns integer
language sql immutable as $$
 select case p_stage
  when 'odm_processing' then 1
  when 'geotiff' then 2 when 'ortho_processing' then 2 when 'geotiff_dependency' then 2
  when 'metadata' then 3 when 'metadata_processing' then 3
  when 'cog' then 4 when 'cog_processing' then 4
  when 'thumbnail' then 5 when 'thumbnail_processing' then 5
  when 'deadwood' then 6 when 'deadwood_v1' then 6 when 'deadwood_segmentation' then 6
  when 'treecover' then 7 when 'treecover_v1' then 7 when 'treecover_segmentation' then 7 when 'forest_cover_segmentation' then 7
  when 'deadwood_treecover_combined_v2' then 8 when 'deadwood_treecover_combined_segmentation' then 8
  when 'aoi_v1' then 9 when 'aoi_segmentation' then 9
  when 'embeddings_v1' then 10 when 'embedding_processing' then 10
  when 'doy_estimation_v1' then 11 when 'doy_estimation' then 11
  when 'georef_check_v1' then 12 when 'georef_check' then 12 end;
$$;

-- The processor stores a check and its audit suggestion in one transaction, so
-- a failure can never leave a new check next to a stale, possibly opposite
-- suggestion. p_suggestion null removes the stage's earlier suggestion (an
-- uncertain call suggests nothing).
create or replace function public.store_georef_check(p_check jsonb, p_suggestion jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_dataset bigint := (p_check ->> 'dataset_id')::bigint;
begin
    if (auth.jwt() ->> 'email') is distinct from 'processor@deadtrees.earth' then
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
    if p_suggestion is null or jsonb_typeof(p_suggestion) = 'null' then
        delete from public.dataset_audit_suggestions
        where dataset_id = v_dataset and source = 'georef_check_v1';
    else
        insert into public.dataset_audit_suggestions (dataset_id, field, value, source, reason, details, updated_at)
        values (v_dataset, 'is_georeferenced', p_suggestion -> 'value', 'georef_check_v1', p_suggestion ->> 'reason',
                coalesce(p_suggestion -> 'details', '{}'::jsonb), now())
        on conflict (dataset_id, field) do update set
            value = excluded.value,
            source = excluded.source,
            reason = excluded.reason,
            details = excluded.details,
            updated_at = excluded.updated_at;
    end if;
end;
$$;
revoke all on function public.store_georef_check(jsonb, jsonb) from public, anon;
grant execute on function public.store_georef_check(jsonb, jsonb) to authenticated, service_role;
