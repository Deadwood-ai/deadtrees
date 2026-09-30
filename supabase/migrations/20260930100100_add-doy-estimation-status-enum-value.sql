-- current_status while the processor runs the acquisition-date estimation stage.
alter type public.v2_status
  add value if not exists 'doy_estimation';
