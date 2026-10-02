-- Track completion of the georeferencing check stage (georef_check_v1). The
-- stage measures the ortho's offset against satellite imagery and stores the
-- evidence in v2_georef_checks.
alter table public.v2_statuses
  add column if not exists is_georef_check_done boolean not null default false;
