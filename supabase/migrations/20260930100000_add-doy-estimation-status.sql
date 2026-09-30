-- Track completion of the acquisition-date estimation stage (doy_estimation_v1).
-- The stage predicts a distribution over the flight day of year from the
-- orthophoto (and Sentinel-2 where the Sentinel pipeline has the block) and
-- stores it in v2_acquisition_date_estimates.
alter table public.v2_statuses
  add column if not exists is_doy_estimation_done boolean not null default false;
