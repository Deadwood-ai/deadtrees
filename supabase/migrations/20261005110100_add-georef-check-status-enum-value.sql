-- current_status while the processor runs the georeferencing check stage.
alter type public.v2_status
  add value if not exists 'georef_check';
