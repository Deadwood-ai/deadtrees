-- current_status while the processor runs the georeferencing check stage.
set local lock_timeout = '5s';

alter type public.v2_status
  add value if not exists 'georef_check';
