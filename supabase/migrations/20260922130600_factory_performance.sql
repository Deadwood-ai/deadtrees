-- Bound row hydration to the requested page; keep filter predicates visible to
-- the planner. Exact totals and global aggregates remain proportional to input.
begin;
-- This pure scalar expression must inline when projected in aggregate queries.
-- It has no relation access and remains private to the gated Factory functions.
alter function public.factory_status_ready(public.v2_statuses,text) reset search_path;
create or replace view public.factory_dataset_records with (security_invoker = true) as
select d.id as dataset_id, d.file_name, d.created_at, d.user_id,
  u.email::text as user_email, ui.organisation, d.archived,
  case when q.is_processing then 'claimed'
    when s.has_error then 'failed'
    when q.id is not null then 'queued'
    when s.current_status <> 'idle' then 'uncertain'
    when ready.value then 'ready' else 'incomplete' end as state,
  s.current_status::text as stage, coalesce(s.has_error,false) as has_error,
  left(s.error_message,2000) as error_message,
  q.claimed_by as worker_id, q.claimed_at, q.created_at as queued_at,
  q.priority as queue_priority, q.task_types,
  greatest(s.updated_at, (select l.created_at from public.v2_logs l where l.dataset_id=d.id order by l.created_at desc limit 1), q.claimed_at) as last_signal_at,
  ready.value as is_ready, coalesce(s.is_upload_done,false) as upload_done,
  coalesce(n.status,'none') as notification_state,
  coalesce(delivery.problem,false) as notification_problem,
  coalesce(pub.status,'none') as publication_state,
  coalesce(reports.open_reports,0::bigint) as open_reports,
  exists (select 1 from public.dataset_audit a where a.dataset_id=d.id) as has_audit,
  'unknown'::text as intent
from public.v2_datasets d
left join auth.users u on u.id=d.user_id
left join (select distinct on ("user") "user",organisation from public.user_info order by "user",id) ui on ui."user"=d.user_id
left join public.v2_statuses s on s.dataset_id=d.id
left join (select distinct on (dataset_id) dataset_id,id,is_processing,claimed_by,claimed_at,created_at,priority,task_types
  from public.v2_queue order by dataset_id,is_processing desc,priority desc,created_at,id) q on q.dataset_id=d.id
left join (select distinct on (dataset_id) dataset_id,status from public.processing_notification_events
  order by dataset_id,created_at desc,id desc) n on n.dataset_id=d.id
left join (select distinct on (j.dataset_id) j.dataset_id,p.status::text from public.data_publication p
  join public.jt_data_publication_datasets j on j.publication_id=p.id
  order by j.dataset_id,p.created_at desc,p.id desc) pub on pub.dataset_id=d.id
left join (select dataset_id,true as problem from public.processing_notification_events
 where status='failed' or (status in ('pending','sending') and next_attempt_at<now()) group by dataset_id) delivery on delivery.dataset_id=d.id
left join (select dataset_id,count(*) as open_reports from public.dataset_flags where status<>'resolved' group by dataset_id) reports on reports.dataset_id=d.id
cross join lateral (select public.factory_status_ready(s,d.file_name) as value) ready;

create or replace view public.factory_attention_records with (security_invoker=true) as
select r.*,reason.value as attention_reason,
 case reason.value when 'failed' then failure.since when 'uncertain' then s.updated_at
 when 'overdue' then m.uploaded_at when 'delivery' then delivery.since
 when 'report' then report.since when 'silent' then r.last_signal_at end as attention_since,
 case reason.value when 'failed' then 1 when 'uncertain' then 2 when 'overdue' then 3
 when 'delivery' then 4 when 'report' then 5 when 'silent' then 6 end as attention_rank,
 failure.since as failure_since,delivery.since as delivery_since,report.since as report_since
from public.factory_dataset_records r
left join public.v2_statuses s on s.dataset_id=r.dataset_id
left join public.factory_submissions m on m.dataset_id=r.dataset_id
left join (select dataset_id,failed_at as since from public.factory_failure_episodes where recovered_at is null) failure on failure.dataset_id=r.dataset_id
left join (select dataset_id,min(created_at) as since from public.processing_notification_events
 where status='failed' or (status in ('pending','sending') and next_attempt_at<now()) group by dataset_id) delivery on delivery.dataset_id=r.dataset_id
left join (select dataset_id,min(created_at) as since from public.dataset_flags where status<>'resolved' group by dataset_id) report on report.dataset_id=r.dataset_id
cross join lateral(select case
 when r.has_error and r.state<>'claimed' then 'failed'
 when r.state='uncertain' then 'uncertain'
 when m.first_ready_at is null and m.workflow='geotiff' and m.input_bytes<1073741824 and m.uploaded_at<now()-interval '2 hours' then 'overdue'
 when r.notification_problem then 'delivery'
 when r.open_reports>0 then 'report'
 when r.state='claimed' and r.last_signal_at<now()-interval '1 hour' then 'silent'
 end as value) reason;


drop function public.factory_filtered_datasets(jsonb);
create function public.factory_filtered_datasets(p_filters jsonb)
returns setof public.factory_attention_records
language sql stable as $$
  select r.* from public.factory_attention_records r
  left join public.factory_submissions m on m.dataset_id=r.dataset_id
  where (coalesce(p_filters->>'workflow','all')='all' or coalesce(m.workflow,case when lower(r.file_name) like '%.zip' then 'odm' else 'geotiff' end)=p_filters->>'workflow')
  and (coalesce(p_filters->>'size','all')='all'
    or (p_filters->>'size'='small' and m.input_bytes<1073741824)
    or (p_filters->>'size'='large' and m.input_bytes>=1073741824)
    or (p_filters->>'size'='unknown' and m.input_bytes is null))
  and (not p_filters ? 'metric' or case p_filters->>'metric'
    when 'waiting' then m.dataset_id is not null and m.first_ready_at is null
    when 'failed_submission' then m.dataset_id is not null and m.first_ready_at is null and r.has_error
    when 'overdue' then m.first_ready_at is null and m.workflow='geotiff' and m.input_bytes<1073741824 and m.uploaded_at<now()-interval '2 hours'
    when 'unresolved_failure' then exists(select 1 from public.factory_failure_episodes f where f.dataset_id=r.dataset_id and f.recovered_at is null)
    else r.dataset_id in(select e.dataset_id from public.factory_metric_events e where e.metric=p_filters->>'metric'
      and (not p_filters ? 'metric_after' or e.happened_at>=(p_filters->>'metric_after')::timestamptz)
      and (not p_filters ? 'metric_before' or e.happened_at<(p_filters->>'metric_before')::timestamptz)) end)
  and (coalesce(p_filters->>'archived','no')='all'
    or r.archived=(coalesce(p_filters->>'archived','no')='yes'))
  and (coalesce(p_filters->>'search','')='' or concat_ws(' ',r.dataset_id::text,r.file_name,r.user_email,r.organisation)
    ilike '%' || (p_filters->>'search') || '%')
  and (coalesce(p_filters->>'state','all')='all' or r.state=p_filters->>'state')
  and (coalesce(p_filters->>'worker','')='' or r.worker_id=p_filters->>'worker')
  and (coalesce(p_filters->>'contributor','')='' or r.user_id=(p_filters->>'contributor')::uuid)
  and (not p_filters ? 'created_after' or r.created_at >= (p_filters->>'created_after')::timestamptz)
  and (not p_filters ? 'created_before' or r.created_at < (p_filters->>'created_before')::timestamptz)
  and (not p_filters ? 'ids' or r.dataset_id = any(array(select value::bigint from jsonb_array_elements_text(p_filters->'ids'))))
  and (coalesce(p_filters->>'notification','all')='all'
    or (p_filters->>'notification'='problem' and r.notification_problem)
    or r.notification_state=p_filters->>'notification')
  and (coalesce(p_filters->>'publication','all')='all' or r.publication_state=p_filters->>'publication')
  and (coalesce(p_filters->>'reports','')<>'open' or r.open_reports>0)
  and (not p_filters ? 'uploaded' or r.upload_done=(p_filters->>'uploaded')::boolean)
  and (not p_filters ? 'has_error' or r.has_error=(p_filters->>'has_error')::boolean)
  and (not p_filters ? 'has_audit' or r.has_audit=(p_filters->>'has_audit')::boolean)
  and (not p_filters ? 'ready' or r.is_ready=(p_filters->>'ready')::boolean)
  and (not coalesce((p_filters->>'attention')::boolean,false)
    or r.attention_reason is not null);
$$;
revoke all on function public.factory_filtered_datasets(jsonb) from public,anon,authenticated;

create or replace function public.factory_datasets(p_filters jsonb default '{}',p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' set plan_cache_mode='force_custom_plan' as $$
declare result jsonb; attention_sort boolean:=coalesce(p_filters->>'sort','newest')='attention';
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 if p_filters is null or jsonb_typeof(p_filters)<>'object' or p_limit is null or p_limit<1 or p_limit>500
 or p_offset is null or p_offset<0 or coalesce(p_filters->>'sort','newest') not in ('newest','attention') then
 raise exception 'Invalid Factory pagination or filters' using errcode='22023'; end if;
 with filtered as materialized(select dataset_id,
 case when attention_sort then attention_rank end as attention_rank,
 case when attention_sort then attention_since end as attention_since
 from public.factory_filtered_datasets(p_filters)),
 page_ids as(select * from filtered order by case when attention_sort then attention_rank end nulls last,
 case when attention_sort then attention_since end nulls last,dataset_id desc limit p_limit offset p_offset),
 page as(select a.* from page_ids p cross join lateral (select * from public.factory_attention_records where dataset_id=p.dataset_id offset 0) a)
 select jsonb_build_object('as_of',now(),'total',(select count(*) from filtered),'items',coalesce((select jsonb_agg(to_jsonb(page)
 order by case when attention_sort then attention_rank end nulls last,case when attention_sort then attention_since end nulls last,dataset_id desc) from page),'[]'::jsonb)) into result;
 return result;
end;
$$;


create or replace function public.factory_operations() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 with population as materialized(select dataset_id,user_id,attention_reason,attention_rank,attention_since,state,
 queued_at,claimed_at,has_error,failure_since,notification_problem,delivery_since,open_reports,report_since
 from public.factory_attention_records where not archived),
 attention as(select * from population where attention_reason is not null),
 top_ids as(select dataset_id from attention order by attention_rank,attention_since nulls last,dataset_id desc limit 10),
 top_attention as(select a.* from top_ids t cross join lateral (select * from public.factory_attention_records where dataset_id=t.dataset_id offset 0) a),
 waiting as(
 select 1 as position,'queued' as key,count(*) as count,min(queued_at) as oldest_at,'Oldest queue entry' as age_label,'{"state":"queued"}'::jsonb as filters from population where state='queued'
 union all select 2,'processing',count(*),min(claimed_at),'Oldest claim','{"state":"claimed"}'::jsonb from population where state='claimed'
 union all select 3,'failed',count(*),min(failure_since),'Oldest recorded open failure','{"has_error":true}'::jsonb from population where has_error
 union all select 4,'delivery',count(*),min(delivery_since),'Oldest notification with a delivery problem','{"notification":"problem"}'::jsonb from population where notification_problem
 union all select 5,'reports',count(*),min(report_since),'Oldest open report','{"reports":"open"}'::jsonb from population where open_reports>0
 ) select jsonb_build_object('as_of',now(),'attention_total',(select count(*) from attention),
 'attention_contributors',(select count(distinct user_id) from attention),
 'attention',coalesce((select jsonb_agg(to_jsonb(top_attention) order by attention_rank,attention_since nulls last,dataset_id desc) from top_attention),'[]'::jsonb),
 'waiting',(select jsonb_agg(to_jsonb(waiting)-'position' order by position) from waiting),
 'coverage',jsonb_build_array(
 'Attention order: recorded failure without an active claim, uncertain status, qualifying overdue first result, delivery problem, open report, then silent claim. Within each reason, known oldest timestamps come first; missing ages remain unknown.',
 'Overdue means upload-to-first-result exceeds two hours for tracked GeoTIFF inputs under 1 GiB. This is not a queue-only deadline and never cancels work.',
 'A silent claim has no recorded database signal for over an hour; a legitimate long stage can look the same. It does not prove a stuck worker.',
 'Queue, claim, failure, notification and report ages use different clocks. Oldest known failure excludes legacy failures without a measured start.',
 'Waiting groups overlap. Counts and ages identify work to investigate, not proven stage capacity or the system constraint. Per-stage wait history and live worker heartbeat are unavailable.'
 )) into result;
 return result;
end;
$$;

create or replace function public.factory_trends(p_interval text default 'week',p_workflow text default 'all',p_size text default 'all')
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' as $$
declare result jsonb; epoch timestamptz; start_at timestamptz; step interval;
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 if p_interval is null or p_interval not in ('day','week') or p_workflow is null or p_workflow not in ('all','geotiff','odm') or p_size is null or p_size not in ('all','small','large','unknown') then
 raise exception 'Invalid Factory trend filters' using errcode='22023'; end if;
 select started_at into epoch from public.factory_measurement_epoch;
 step:=case p_interval when 'week' then interval '1 week' else interval '1 day' end;
 start_at:=(date_trunc(p_interval,now() at time zone 'UTC')-step*(case p_interval when 'week' then 11 else 27 end)) at time zone 'UTC';
 with population as materialized (
   select d.id,d.user_id,s.has_error,s.is_upload_done,m.uploaded_at,m.first_ready_at,m.input_bytes,m.workflow,
    extract(epoch from(m.first_ready_at-m.uploaded_at))/3600.0 as lead_hours
   from public.v2_datasets d left join public.factory_submissions m on m.dataset_id=d.id
   left join public.v2_statuses s on s.dataset_id=d.id where (p_workflow='all' or coalesce(m.workflow,case when lower(d.file_name) like '%.zip' then 'odm' else 'geotiff' end)=p_workflow)
   and (p_size='all' or (p_size='small' and m.input_bytes<1073741824)
    or (p_size='large' and m.input_bytes>=1073741824) or (p_size='unknown' and m.input_bytes is null))
 ), failures as materialized (
   select f.*,extract(epoch from(f.recovered_at-f.failed_at))/3600.0 as recovery_hours
   from public.factory_failure_episodes f join population p on p.id=f.dataset_id
 ), events as materialized (
   select date_trunc(p_interval,e.happened_at) as bucket,e.metric,count(*) as amount
   from public.factory_metric_events e join population p on p.id=e.dataset_id
   where e.happened_at>=start_at and e.happened_at<=now() group by 1,2
 ), buckets as (
   select t as start,t+step as finish,t+step>now() or (epoch>t and epoch<t+step) as partial,t+step>epoch as measured
   from generate_series(start_at,date_trunc(p_interval,now() at time zone 'UTC') at time zone 'UTC',step) t
 ), series as (
 select b.start,b.finish as "end",b.partial,b.measured,
   case when measured then (select coalesce(sum(e.amount),0) from events e where e.metric='uploaded' and e.bucket=b.start) end as uploaded,
   case when measured then count(p.id) end as first_ready,
   case when measured then sum(p.input_bytes)/1073741824.0 end as completed_input_gib,
   case when measured then count(p.input_bytes) end as volume_samples,
   percentile_cont(0.5) within group(order by p.lead_hours) as lead_p50_hours,
   percentile_cont(0.9) within group(order by p.lead_hours) as lead_p90_hours,
   case when measured then count(p.lead_hours) end as lead_samples,
   case when measured then (select count(*) from failures f where f.failed_at>=b.start and f.failed_at<b.finish) end as failures,
   case when measured then (select count(*) from failures f where f.recovered_at>=b.start and f.recovered_at<b.finish) end as recovered,
   (select percentile_cont(0.5) within group(order by f.recovery_hours) from failures f where f.recovered_at>=b.start and f.recovered_at<b.finish) as recovery_p50_hours,
   (select percentile_cont(0.9) within group(order by f.recovery_hours) from failures f where f.recovered_at>=b.start and f.recovered_at<b.finish) as recovery_p90_hours,
   (select coalesce(sum(e.amount),0) from events e where e.metric='registered' and e.bucket=b.start) as registered,
   (select coalesce(sum(e.amount),0) from events e where e.metric='recorded_completed' and e.bucket=b.start) as recorded_completed,
   (select coalesce(sum(e.amount),0) from events e where e.metric='recorded_failed' and e.bucket=b.start) as recorded_failed,
   (select coalesce(sum(e.amount),0) from events e where e.metric='recorded_embedding_completed' and e.bucket=b.start) as recorded_embedding_completed
 from buckets b left join population p on p.first_ready_at>=b.start and p.first_ready_at<b.finish
 group by b.start,b.finish,b.partial,b.measured
 ), summary as (
 select jsonb_build_object(
   'tracked_submissions',count(*) filter(where uploaded_at is not null),
   'first_ready',count(*) filter(where first_ready_at is not null),
   'waiting',count(*) filter(where uploaded_at is not null and first_ready_at is null),
   'failed',count(*) filter(where uploaded_at is not null and first_ready_at is null and has_error),
   'waiting_contributors',count(distinct user_id) filter(where uploaded_at is not null and first_ready_at is null),
   'overdue',count(*) filter(where first_ready_at is null and workflow='geotiff' and input_bytes<1073741824 and uploaded_at<now()-interval '2 hours'),
   'oldest_wait_hours',max(extract(epoch from(now()-uploaded_at))/3600.0) filter(where first_ready_at is null),
   'lead_p50_hours',percentile_cont(0.5) within group(order by lead_hours),
   'lead_p90_hours',percentile_cont(0.9) within group(order by lead_hours),
   'lead_samples',count(lead_hours),
   'recovered',(select count(*) from failures where recovered_at is not null),
   'unresolved_failures',(select count(*) from failures where recovered_at is null),
   'recovery_p50_hours',(select percentile_cont(0.5) within group(order by recovery_hours) from failures),
   'recovery_p90_hours',(select percentile_cont(0.9) within group(order by recovery_hours) from failures),
   'completed_input_gib',sum(input_bytes) filter(where first_ready_at is not null)/1073741824.0,
   'volume_samples',count(input_bytes) filter(where first_ready_at is not null),
   'missing_volume',count(*) filter(where first_ready_at is not null and input_bytes is null),
   'legacy_uploaded',count(*) filter(where is_upload_done and uploaded_at is null)
 ) as value from population
 )
 select jsonb_build_object('as_of',now(),'tracking_since',epoch,'interval',p_interval,'workflow',p_workflow,'size',p_size,
   'summary',(select value from summary),'series',(select jsonb_agg(to_jsonb(series) order by start) from series),
   'coverage',jsonb_build_array(
    'Measured submissions begin with registrations after tracking started. Earlier uploads are excluded from timing and volume denominators; no historical times are inferred.',
    'First result follows all required readiness flags, including upload, ODM for ZIP, imagery, predictions and required AOI. It is not a scientific quality review or a live storage accessibility probe.',
    'Input GiB uses the original uploaded file byte count, once at first readiness. Missing sizes are excluded and reported; output MB and retries are never added.',
    'Lead time includes queueing, all required stages and recovery. Completion percentiles exclude still-waiting submissions; their count and oldest wait remain visible.',
    'Two-hour warnings apply only to measured GeoTIFF inputs below 1 GiB. ZIP and larger inputs have no validated target yet. Warnings never cancel work.',
    'Failure episodes start on a persisted error and close only at full readiness. Internal retries that never persist an error are not counted as user failures.',
    'Historical recorded outcomes deduplicate notification recipients by queue task and event type. Recording depends on notification configuration; absent events do not prove no processing.',
    'Embedding task mix describes requested tasks, not proven enrichment intent. Registered datasets are not completed uploads. History includes archived datasets; deletion removes their measurements.'
   )) into result;
 return result;
end;
$$;

create or replace function public.factory_journey() returns jsonb
language plpgsql stable security definer set search_path='' set timezone='UTC' as $$
declare epoch timestamptz; activation_epoch timestamptz; result jsonb;
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 select started_at,activation_started_at into epoch,activation_epoch from public.factory_measurement_epoch;
 with population as materialized (
  select d.user_id,m.* from public.factory_submissions m join public.v2_datasets d on d.id=m.dataset_id
 ), first_upload as (
  select distinct on (user_id) * from population where user_id is not null order by user_id,uploaded_at,dataset_id
 ), returning_users as (
  select f.user_id,bool_or(p.uploaded_at>f.uploaded_at and p.uploaded_at<=f.uploaded_at+interval '30 days') as returned
  from first_upload f join population p on p.user_id=f.user_id group by f.user_id
 ), legacy_users as (
  select distinct d.user_id from public.v2_datasets d join public.v2_statuses s on s.dataset_id=d.id
  left join public.factory_submissions m on m.dataset_id=d.id where s.is_upload_done and m.dataset_id is null
 ), contributors as (
  select f.*,v.viewed_at,
   r.returned,
   f.uploaded_at>=activation_epoch and f.uploaded_at<=now()-interval '7 days' as activation_eligible,
   f.uploaded_at<=now()-interval '30 days' as retention_eligible
  from first_upload f join returning_users r using(user_id) left join public.factory_result_views v on v.dataset_id=f.dataset_id and v.user_id=f.user_id
  where not exists(select 1 from legacy_users l where l.user_id=f.user_id)
 ), cohorts as (
  select date_trunc('week',uploaded_at) as week,count(*) as contributors,
   count(*) filter(where activation_eligible) as activation_eligible,
   case when count(*) filter(where activation_eligible)>0 then count(*) filter(where activation_eligible and viewed_at<=uploaded_at+interval '7 days') end as activated_7d,
   count(*) filter(where retention_eligible) as retention_eligible,
   case when count(*) filter(where retention_eligible)>0 then count(*) filter(where retention_eligible and returned) end as returned_30d
  from contributors where uploaded_at>=date_trunc('week',now())-interval '25 weeks' group by 1
 ), buckets as (
  select start,start+interval '1 week' as finish from generate_series(date_trunc('week',now())-interval '11 weeks',date_trunc('week',now()),interval '1 week') start
 ), weekly as (
  select start,finish as "end",finish>now() or epoch>start and epoch<finish or activation_epoch>start and activation_epoch<finish as partial,
   case when finish>epoch then (select count(*) from population p where p.uploaded_at>=start and p.uploaded_at<finish and p.uploaded_at<=now()) end as uploads,
   case when finish>epoch then (select count(*) from population p where p.first_ready_at>=start and p.first_ready_at<finish and p.first_ready_at<=now()) end as first_ready,
   case when finish>activation_epoch then (select count(*) from public.factory_result_views v where v.viewed_at>=start and v.viewed_at<finish and v.viewed_at<=now()) end as observed_views,
   (select count(*) from public.data_publication p where p.status='published' and p.published_at>=start and p.published_at<finish and p.published_at<=now()) as publications
  from buckets
 ), pipeline as (
  select count(*) filter(where upload_done) as uploaded,count(*) filter(where state='queued') as queued,
   count(*) filter(where state='claimed') as processing,count(*) filter(where is_ready) as ready,
   count(*) filter(where has_error) as failed,count(*) filter(where has_audit) as audited,
   count(*) filter(where publication_state='published') as published
  from public.factory_dataset_records r where not archived
 )
 select jsonb_build_object('as_of',now(),'tracking_since',epoch,'activation_tracking_since',activation_epoch,
  'pipeline',(select to_jsonb(pipeline) from pipeline),
  'weekly',coalesce((select jsonb_agg(to_jsonb(weekly) order by start) from weekly),'[]'::jsonb),
  'cohorts',coalesce((select jsonb_agg(to_jsonb(cohorts) order by week desc) from cohorts),'[]'::jsonb),
  'coverage',jsonb_build_array(
   'Pipeline counts are current unarchived dataset stocks. Stages overlap; they are not a conversion funnel.',
   'Weekly flows count distinct first milestones; publication counts are publications, not datasets. History includes archived datasets.',
   'Result views are first observed visits by the dataset owner after complete processing, recorded only with analytics consent. A page visit does not prove that imagery loaded or was understood.',
   'Observed activation is a lower bound: missing consent, blocked telemetry and visits before tracking are unknown, not abandonment.',
   'Cohorts start at the first tracked completed upload and exclude contributors with known legacy uploads. Deleted historical data can limit first-ever classification.',
   'Activation uses the first submission viewed within 7 days, with observation available from upload; retention means another completed upload within 30 days. Only elapsed windows enter denominators.',
   'Audit records do not prove a quality pass. Publications do not prove external reuse, referrals, citations or revenue.'
  )) into result;
 return result;
end;
$$;

create or replace function public.factory_overview(p_days integer default 7)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; since_at timestamptz;
begin
  if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
  if p_days is null or p_days<1 or p_days>365 then raise exception 'Invalid Factory period' using errcode='22023'; end if;
  since_at := now()-make_interval(days=>p_days);
  select jsonb_build_object('as_of',now(),'since',since_at,
    'counts',(select jsonb_build_object('uncertain',count(*) filter(where state='uncertain'),
      'publication_pending',count(*) filter(where publication_state in ('pending','uploading','in_review','error')))
      from public.factory_dataset_records where not archived),
    'workers',coalesce((select jsonb_agg(jsonb_build_object('worker_id',q.claimed_by,'dataset_id',q.dataset_id,
      'claimed_at',q.claimed_at,'task_types',q.task_types,'last_signal_at',r.last_signal_at) order by q.claimed_at)
      from public.v2_queue q join public.factory_dataset_records r on r.dataset_id=q.dataset_id where q.is_processing and not r.archived),'[]'::jsonb),
    'coverage',jsonb_build_array(
      'Queue claims and database signals do not prove live worker progress. Complete attempt history is unavailable.',
      'Publication backlog counts reflect the latest publication record per unarchived dataset, not a count of publication requests.'
    )) into result;
  return result;
end;
$$;


create or replace function public.factory_activity(p_kind text default 'all',p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; total bigint;
begin
  if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
  if p_kind is null or p_kind not in ('all','uploads','processing','notifications','publications','reports')
    or p_limit is null or p_limit<1 or p_limit>500 or p_offset is null or p_offset<0
    then raise exception 'Invalid Factory activity query' using errcode='22023'; end if;
  select
    case when p_kind in ('all','uploads') then (select count(*) from public.v2_datasets) else 0 end
    + case when p_kind in ('all','processing') then (select count(*) from public.v2_logs where dataset_id is not null) else 0 end
    + case when p_kind in ('all','notifications') then (select count(*) from public.processing_notification_events) else 0 end
    + case when p_kind in ('all','publications') then (select count(*) from public.data_publication) else 0 end
    + case when p_kind in ('all','reports') then (select count(*) from public.dataset_flags) else 0 end into total;
  with events as (
    (select 'uploads'::text as kind,d.id::text as id,d.id as dataset_id,d.created_at,
      case when s.is_upload_done then 'upload_done' else 'incomplete' end as state,d.file_name::text as summary
      from public.v2_datasets d left join public.v2_statuses s on s.dataset_id=d.id where p_kind in ('all','uploads') order by d.created_at desc,d.id::text desc limit p_limit::bigint+p_offset)
    union all (select 'processing',l.id::text,l.dataset_id,l.created_at,l.level::text,left(l.message,500)
      from public.v2_logs l where l.dataset_id is not null and p_kind in ('all','processing') order by l.created_at desc,l.id::text desc limit p_limit::bigint+p_offset)
    union all (select 'notifications',n.id::text,n.dataset_id,n.created_at,n.status,n.event_type
      from public.processing_notification_events n where p_kind in ('all','notifications') order by n.created_at desc,n.id::text desc limit p_limit::bigint+p_offset)
    union all (select 'publications',p.id::text,null::bigint,p.created_at,p.status::text,coalesce(p.doi,p.title,'Publication record')
      from public.data_publication p where p_kind in ('all','publications') order by p.created_at desc,p.id::text desc limit p_limit::bigint+p_offset)
    union all (select 'reports',f.id::text,f.dataset_id,f.created_at,f.status,left(f.description,500)
      from public.dataset_flags f where p_kind in ('all','reports') order by f.created_at desc,f.id::text desc limit p_limit::bigint+p_offset)
  ), page as (select * from events order by created_at desc,kind,id desc limit p_limit offset p_offset)
  select jsonb_build_object('as_of',now(),'total',total,
    'items',coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc,kind,id desc) from page p),'[]'::jsonb)) into result;
  return result;
end;
$$;

create index v2_logs_factory_activity_idx on public.v2_logs(created_at desc,(id::text) desc) where dataset_id is not null;

create index v2_datasets_factory_activity_idx on public.v2_datasets(created_at desc,(id::text) desc);

create index processing_notification_events_factory_activity_idx on public.processing_notification_events(created_at desc,(id::text) desc);

create index data_publication_factory_activity_idx on public.data_publication(created_at desc,(id::text) desc);

create index dataset_flags_factory_activity_idx on public.dataset_flags(created_at desc,(id::text) desc);

create or replace function public.factory_dataset(p_dataset_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare dataset jsonb; result jsonb;
begin
  if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
  select to_jsonb(r) into dataset from public.factory_dataset_records r where dataset_id=p_dataset_id;
  if dataset is null then return jsonb_build_object('as_of',now(),'dataset',null); end if;
  select jsonb_build_object('as_of',now(),'dataset',dataset,
    'status',(select to_jsonb(s) || coalesce(to_jsonb(m)-'dataset_id','{}'::jsonb)
      from public.v2_statuses s left join public.factory_submissions m on m.dataset_id=s.dataset_id where s.dataset_id=p_dataset_id),
    'queue',coalesce((select jsonb_agg(to_jsonb(q)) from (
      select id,created_at,is_processing,priority,task_types,claimed_by,claimed_at
      from public.v2_queue where dataset_id=p_dataset_id order by created_at desc,id desc limit 200) q),'[]'::jsonb),
    'logs',coalesce((select jsonb_agg(to_jsonb(l)) from (
      select id,created_at,level,category,left(message,4000) as message
      from public.v2_logs where dataset_id=p_dataset_id order by created_at desc,id desc limit 200) l),'[]'::jsonb),
    'log_total',(select count(*) from public.v2_logs where dataset_id=p_dataset_id),
    'outputs',jsonb_build_object(
      'orthos',coalesce((select jsonb_agg(to_jsonb(o)) from (select version,created_at,ortho_file_size,ortho_upload_runtime from public.v2_orthos where dataset_id=p_dataset_id order by created_at desc,version desc limit 200) o),'[]'::jsonb),
      'cogs',coalesce((select jsonb_agg(to_jsonb(o)) from (select version,created_at,cog_file_size,cog_processing_runtime from public.v2_cogs where dataset_id=p_dataset_id order by created_at desc,version desc limit 200) o),'[]'::jsonb),
      'thumbnails',coalesce((select jsonb_agg(to_jsonb(o)) from (select version,created_at,thumbnail_file_size,thumbnail_processing_runtime from public.v2_thumbnails where dataset_id=p_dataset_id order by created_at desc,version desc limit 200) o),'[]'::jsonb),
      'raw_images',coalesce((select jsonb_agg(to_jsonb(o)) from (select version,created_at,raw_image_count,raw_image_size_mb from public.v2_raw_images where dataset_id=p_dataset_id order by created_at desc,version desc limit 200) o),'[]'::jsonb)),
    'notifications',coalesce((select jsonb_agg(to_jsonb(n)) from (
      select id,event_type,status,recipient_roles,delivery_attempts,next_attempt_at,sent_at,created_at,left(delivery_error,2000) as delivery_error
      from public.processing_notification_events where dataset_id=p_dataset_id order by created_at desc,id desc limit 200) n),'[]'::jsonb),
    'publications',coalesce((select jsonb_agg(to_jsonb(p)) from (
      select p.id,p.status,p.doi,p.created_at,p.published_at from public.data_publication p
      join public.jt_data_publication_datasets j on j.publication_id=p.id where j.dataset_id=p_dataset_id order by p.created_at desc,p.id desc limit 200) p),'[]'::jsonb),
    'reports',coalesce((select jsonb_agg(to_jsonb(f)) from (
      select id,concat_ws(', ',case when is_ortho_mosaic_issue then 'orthomosaic' end,case when is_prediction_issue then 'prediction' end) as flag_type,
      status,created_at,updated_at,left(description,4000) as description,left(auditor_comment,2000) as auditor_comment
      from public.dataset_flags where dataset_id=p_dataset_id order by created_at desc,id desc limit 200) f),'[]'::jsonb),
    'audits',coalesce((select jsonb_agg(to_jsonb(a)) from (select audit_date,reviewed_at,final_assessment,has_major_issue,left(notes,4000) as notes
      from public.dataset_audit where dataset_id=p_dataset_id order by reviewed_at desc nulls last,audit_date desc limit 200) a),'[]'::jsonb),
    'corrections',coalesce((select jsonb_agg(to_jsonb(c)) from (select id,layer_type,operation,created_at,review_status,reviewed_at
      from public.v2_geometry_corrections where dataset_id=p_dataset_id order by created_at desc,id desc limit 200) c),'[]'::jsonb),
    'record_totals',jsonb_build_object('queue',(select count(*) from public.v2_queue where dataset_id=p_dataset_id),
      'orthos',(select count(*) from public.v2_orthos where dataset_id=p_dataset_id),
      'cogs',(select count(*) from public.v2_cogs where dataset_id=p_dataset_id),
      'thumbnails',(select count(*) from public.v2_thumbnails where dataset_id=p_dataset_id),
      'raw_images',(select count(*) from public.v2_raw_images where dataset_id=p_dataset_id),
      'notifications',(select count(*) from public.processing_notification_events where dataset_id=p_dataset_id),
      'reports',(select count(*) from public.dataset_flags where dataset_id=p_dataset_id),
      'audits',(select count(*) from public.dataset_audit where dataset_id=p_dataset_id),
      'publications',(select count(*) from public.jt_data_publication_datasets where dataset_id=p_dataset_id)),
    'correction_total',(select count(*) from public.v2_geometry_corrections where dataset_id=p_dataset_id)
  ) into result;
  return result;
end;
$$;


-- Complex dashboard joins should execute rather than spend seconds compiling
-- JIT code after the planner crosses its cost threshold. Scope this to these RPCs.
alter function public.factory_datasets(jsonb,integer,integer) set jit=off;
alter function public.factory_operations() set jit=off;
alter function public.factory_overview(integer) set jit=off;
alter function public.factory_trends(text,text,text) set jit=off;
alter function public.factory_journey() set jit=off;
alter function public.factory_activity(text,integer,integer) set jit=off;
alter function public.factory_dataset(bigint) set jit=off;
create index factory_failure_dataset_idx on public.factory_failure_episodes(dataset_id);
create index factory_result_view_user_idx on public.factory_result_views(user_id);
notify pgrst,'reload schema';
commit;
