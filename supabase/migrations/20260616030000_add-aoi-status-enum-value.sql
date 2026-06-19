-- Add the 'aoi_segmentation' value to the v2_status enum.
--
-- The processor sets current_status = 'aoi_segmentation' while the automatic
-- AOI task runs. StatusEnum already includes it on the Python side; this adds
-- the matching Postgres enum value so update_status no longer fails with
-- 22P02 "invalid input value for enum v2_status".
alter type public.v2_status
  add value if not exists 'aoi_segmentation';
