-- Acquisition-date estimates: one row per dataset, replaced when the stage reruns.
--
-- probabilities is the calibrated distribution over the flight year on the
-- model's 365-bin circle (bin b covers day-of-year fraction [b/365, (b+1)/365)).
-- The recorded_* columns hold the dataset date the estimate was assessed
-- against, so readers can tell whether the date changed since (for example
-- after an accepted suggestion). The assessment columns (mismatch, suggestion,
-- accept recommendation) are derived by the processor; see
-- processor/src/doy_estimation_v1/assessment.py and docs/doy-estimation.md.
create table if not exists public.v2_acquisition_date_estimates (
  dataset_id bigint primary key references public.v2_datasets (id) on delete cascade,
  model_version text not null,
  -- s2: Sentinel-2 weeks of the flight year were available; nos2: ortho + site only
  model_type text not null check (model_type in ('s2', 'nos2')),
  probabilities real[] not null check (array_length(probabilities, 1) = 365),
  flight_year smallint not null,
  recorded_year smallint,
  recorded_month smallint,
  recorded_day smallint,
  recorded_precision text not null check (recorded_precision in ('day', 'month', 'year')),
  predicted_date date not null,
  mode_date date not null,
  -- highest-density sets: {"50": [["2024-06-01", "2024-07-10"], ...], "80": ..., "95": ..., "99": ...}
  hdi jsonb not null,
  hdi80_days smallint not null,
  n_modes smallint not null,
  -- probability of all days more likely than the recorded date (month: its best day)
  recorded_surprise real,
  recorded_offset_days real,
  is_mismatch boolean not null default false,
  suggested_date date,
  suggestion_reason text check (suggestion_reason in ('missing_month', 'mismatch')),
  recommend_accept boolean,
  -- S2 lookup (block, cube range, weeks), inputs, calibration and rule thresholds
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((suggested_date is null) = (suggestion_reason is null))
);

create index if not exists v2_acquisition_date_estimates_mismatch_idx
  on public.v2_acquisition_date_estimates (dataset_id) where is_mismatch;
create index if not exists v2_acquisition_date_estimates_version_idx
  on public.v2_acquisition_date_estimates (model_version);

grant select on table public.v2_acquisition_date_estimates to anon, authenticated;
grant insert, update, delete on table public.v2_acquisition_date_estimates to authenticated;
grant all on table public.v2_acquisition_date_estimates to service_role;

alter table public.v2_acquisition_date_estimates enable row level security;

-- Read access follows dataset visibility (the dataset page shows the suggested date).
drop policy if exists "Allow read access to acquisition date estimates" on public.v2_acquisition_date_estimates;
create policy "Allow read access to acquisition date estimates"
  on public.v2_acquisition_date_estimates
  for select
  to public
  using (
    exists (
      select 1
      from public.v2_datasets d
      where d.id = v2_acquisition_date_estimates.dataset_id
        and (
          d.data_access <> 'private'::access
          or auth.uid() = d.user_id
          or can_view_all_private_data()
          or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
        )
        and (d.archived = false or auth.uid() = d.user_id)
    )
  );

drop policy if exists "Allow processor to write acquisition date estimates" on public.v2_acquisition_date_estimates;
create policy "Allow processor to write acquisition date estimates"
  on public.v2_acquisition_date_estimates
  for all
  to authenticated
  using ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
  with check ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text);

grant select on public.v2_acquisition_date_estimates to analyst;
drop policy if exists analyst_select on public.v2_acquisition_date_estimates;
create policy analyst_select on public.v2_acquisition_date_estimates for select to analyst using (true);

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
  when 'doy_estimation_v1' then 11 when 'doy_estimation' then 11 end;
$$;
