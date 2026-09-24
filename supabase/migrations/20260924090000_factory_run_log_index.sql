-- Processor-run evidence for the Factory outcome views. Built concurrently in its
-- own migration so the busy v2_logs table keeps accepting writes; the Supabase
-- CLI applies a file without an explicit transaction outside a transaction block.
-- A failed concurrent build leaves an invalid index; the retry then fails on the
-- existing name (no IF NOT EXISTS, so it is never silently accepted) until an
-- operator drops it. The predicate must match factory_run_log_events.
create index concurrently factory_run_log_idx on public.v2_logs(dataset_id,created_at,id) where dataset_id is not null and (
 (category='process' and (message like 'Starting processing for task %' or message like 'Processing failed:%'
  or message like 'Crash detected for dataset %' or message like 'Received signal %; gracefully re-queuing in-flight task %'
  or message like 'Recorded % processing_completed notification event(s) for task %'))
 or (category='ortho' and message like 'Finished converting dataset %')
 or message in ('Combined segmentation completed successfully','Tree cover segmentation completed successfully',
  'Deadwood segmentation completed successfully','AOI segmentation completed successfully','Processed metadata successfully',
  'Thumbnail processing completed successfully','ODM processing completed successfully','Tile embedding completed successfully'));
