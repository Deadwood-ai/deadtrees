-- Make the Factory attention list workable: count "overdue" only for external
-- contributors, and group what needs a person by failure cause.
-- Team backfill (bulk reprocessing by can_audit accounts) is waiting, not broken,
-- so it moves out of attention and is reported as a separate waiting count.
-- Each failure group carries the stage key the processor uses for its Linear
-- cluster issue (fingerprint processor/failure/<stage>).
begin;
set local lock_timeout = '5s';

-- One canonical name per failure stage. Mirrors STAGE_KEY_ALIASES in
-- processor/src/utils/linear_issues.py; legacy rows without error_stage fall
-- back to the stage named in the error message.
create or replace function public.factory_failure_stage(p_error_stage text,p_error_message text)
returns text language sql immutable set search_path='' as $$
 select case raw when 'odm' then 'odm_processing'
  when 'geotiff' then 'ortho_processing' when 'geotiff_dependency' then 'ortho_processing' when 'convert' then 'ortho_processing'
  when 'metadata' then 'metadata_processing' when 'cog' then 'cog_processing' when 'thumbnail' then 'thumbnail_processing'
  when 'deadwood' then 'deadwood_segmentation' when 'deadwood_v1' then 'deadwood_segmentation'
  when 'treecover' then 'forest_cover_segmentation' when 'treecover_v1' then 'forest_cover_segmentation'
  when 'treecover_segmentation' then 'forest_cover_segmentation'
  when 'deadwood_treecover_combined_v2' then 'deadwood_treecover_combined_segmentation'
  when 'aoi_v1' then 'aoi_segmentation' when 'embeddings_v1' then 'embedding_processing'
  when 'doy_estimation_v1' then 'doy_estimation' when 'georef_check_v1' then 'georef_check'
  when 'processing' then 'unknown' else raw end
 from (select lower(coalesce(nullif(p_error_stage,''),
  substring(p_error_message from '^Processing container crashed during (\w+)'),
  substring(p_error_message from '^(\w+) processing failed'),
  case when p_error_message ~* '^(ODM processing failed|No raw_images entry|No supported images|Invalid ZIP|Unsupported ZIP|Bad CRC|Bad magic number)'
   then 'odm_processing' end,
  'unknown')) as raw) s;
$$;

-- A short, stable error class: the first clause after the stage prefixes, with
-- ids and sizes (4+ digits) masked, so repeats of one cause group together while
-- exit codes such as 1 and 137 stay distinct.
create or replace function public.factory_failure_kind(p_error_message text)
returns text language sql immutable set search_path='' as $$
 select nullif(left(btrim(regexp_replace(split_part(split_part(split_part(
  regexp_replace(coalesce(p_error_message,''),'^((\w+ )?processing failed: )+',''),
  E'\n',1),'. ',1),' stdout',1),'[0-9]{4,}','#','g')),80),'');
$$;
revoke all on function public.factory_failure_stage(text,text),public.factory_failure_kind(text) from public,anon,authenticated;

create or replace view public.factory_attention_records with (security_invoker=true) as
select r.*,reason.value as attention_reason,
 case reason.value when 'failed' then failure.since when 'uncertain' then s.updated_at
 when 'overdue' then m.uploaded_at when 'delivery' then delivery.since
 when 'report' then report.since when 'silent' then r.last_signal_at end as attention_since,
 case reason.value when 'failed' then 1 when 'uncertain' then 2 when 'overdue' then 3
 when 'delivery' then 4 when 'report' then 5 when 'silent' then 6 end as attention_rank,
 failure.since as failure_since,delivery.since as delivery_since,report.since as report_since,
 case when reason.value='failed' then public.factory_failure_stage(s.error_stage,r.error_message) end as failure_stage,
 case when reason.value='failed' then public.factory_failure_kind(r.error_message) end as failure_kind,
 team.user_id is not null as team_upload
from public.factory_dataset_records r
left join public.v2_statuses s on s.dataset_id=r.dataset_id
left join public.factory_submissions m on m.dataset_id=r.dataset_id
left join (select dataset_id,failed_at as since from public.factory_failure_episodes where recovered_at is null) failure on failure.dataset_id=r.dataset_id
left join (select dataset_id,min(created_at) as since from public.processing_notification_events
 where status='failed' or (status in ('pending','sending') and next_attempt_at<now()) group by dataset_id) delivery on delivery.dataset_id=r.dataset_id
left join (select dataset_id,min(created_at) as since from public.dataset_flags where status<>'resolved' group by dataset_id) report on report.dataset_id=r.dataset_id
left join (select user_id from public.privileged_users where can_audit) team on team.user_id=r.user_id
cross join lateral(select case
 when r.has_error and r.state<>'claimed' then 'failed'
 when r.state='uncertain' then 'uncertain'
 when m.first_ready_at is null and m.workflow='geotiff' and m.input_bytes<1073741824 and m.uploaded_at<now()-interval '2 hours'
  and team.user_id is null then 'overdue'
 when r.notification_problem then 'delivery'
 when r.open_reports>0 then 'report'
 when r.state='claimed' and r.last_signal_at<now()-interval '1 hour' then 'silent'
 end as value) reason;

create or replace function public.factory_operations() returns jsonb language plpgsql stable security definer set search_path='' set jit=off as $$
declare result jsonb;
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 with population as materialized(select dataset_id,user_id,file_name,attention_reason,attention_rank,attention_since,state,is_ready,team_upload,
 queued_at,claimed_at,has_error,failure_since,notification_problem,delivery_since,open_reports,report_since,failure_stage,failure_kind
 from public.factory_attention_records where not archived),
 attention as(select *,row_number() over(partition by attention_reason,failure_stage,failure_kind
  order by attention_since nulls last,dataset_id desc) as position from population where attention_reason is not null),
 groups as(
 select attention_reason as reason,min(attention_rank) as rank,failure_stage as stage,failure_kind as kind,count(*) as count,
  count(distinct user_id) as contributors,min(attention_since) as oldest_since,
  coalesce(array_agg(dataset_id order by position) filter(where position<=200),'{}') as dataset_ids,
  coalesce(jsonb_agg(jsonb_build_object('dataset_id',dataset_id,'file_name',file_name,'state',state,'attention_since',attention_since)
   order by position) filter(where position<=5),'[]') as samples
 from attention group by attention_reason,failure_stage,failure_kind
 ),
 waiting as(
 select 1 as position,'queued' as key,count(*) as count,min(queued_at) as oldest_at,'Oldest queue entry' as age_label,'{"state":"queued"}'::jsonb as filters from population where state='queued'
 union all select 2,'processing',count(*),min(claimed_at),'Oldest claim','{"state":"claimed"}'::jsonb from population where state='claimed'
 union all select 3,'failed',count(*),min(failure_since),'Oldest recorded open failure','{"has_error":true}'::jsonb from population where has_error
 union all select 4,'delivery',count(*),min(delivery_since),'Oldest notification with a delivery problem','{"notification":"problem"}'::jsonb from population where notification_problem
 union all select 5,'reports',count(*),min(report_since),'Oldest open report','{"reports":"open"}'::jsonb from population where open_reports>0
 ) select jsonb_build_object('as_of',now(),'attention_total',(select count(*) from attention),
 'attention_contributors',(select count(distinct user_id) from attention),
 'attention_groups',coalesce((select jsonb_agg(to_jsonb(groups)-'rank' order by rank,count desc,stage nulls last,kind nulls last) from groups),'[]'::jsonb),
 'team_waiting',(select count(*) from population where team_upload and state in('queued','claimed') and not is_ready),
 'waiting',(select jsonb_agg(to_jsonb(waiting)-'position' order by position) from waiting),
 'coverage',jsonb_build_array(
 'Attention groups datasets by reason, then failures by stage and error class. Order: recorded failure without an active claim, uncertain status, qualifying overdue first result, delivery problem, open report, then silent claim.',
 'Overdue means upload-to-first-result exceeds two hours for tracked GeoTIFF inputs under 1 GiB from external contributors. Team uploads (accounts with audit rights) are waiting work, counted separately, and never overdue. This is not a queue-only deadline and never cancels work.',
 'Failure stages come from the recorded error stage, or from the error message for older failures. Each stage has one Linear cluster issue with fingerprint processor/failure/<stage>.',
 'A silent claim has no recorded database signal for over an hour; a legitimate long stage can look the same. It does not prove a stuck worker.',
 'Queue, claim, failure, notification and report ages use different clocks. Oldest known failure excludes legacy failures without a measured start.',
 'Waiting groups overlap. Counts and ages identify work to investigate, not proven stage capacity or the system constraint. Per-stage wait history and live worker heartbeat are unavailable.'
 )) into result;
 return result;
end;
$$;

notify pgrst,'reload schema';
commit;
