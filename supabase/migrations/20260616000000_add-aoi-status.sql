-- Track completion of the automatic AOI segmentation stage. The aoi_v1 task
-- generates one coarse area-of-interest polygon per dataset (stored in
-- v2_aois) so auditors start from a prediction rather than a blank map.
alter table public.v2_statuses
  add column if not exists is_aoi_done boolean not null default false;
