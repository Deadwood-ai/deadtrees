begin;
-- One event population serves chart counts and matching dataset drill-downs.
-- Recipient delivery rows collapse to one task outcome BEFORE time filtering.
create view public.factory_metric_events with(security_invoker=true) as
 select dataset_id,'uploaded'::text as metric,uploaded_at as happened_at from public.factory_submissions
 union all select dataset_id,'first_ready',first_ready_at from public.factory_submissions where first_ready_at is not null
 union all select dataset_id,'failures',failed_at from public.factory_failure_episodes
 union all select dataset_id,'recovered',recovered_at from public.factory_failure_episodes where recovered_at is not null
 union all select id,'registered',created_at from public.v2_datasets
 union all select dataset_id,case event_type when 'processing_completed' then 'recorded_completed' else 'recorded_failed' end,min(created_at)
 from public.processing_notification_events where event_type in ('processing_completed','processing_failed')
 group by dataset_id,queue_task_id,event_type
 union all select dataset_id,'recorded_embedding_completed',min(created_at)
 from public.processing_notification_events where event_type='processing_completed'
 group by dataset_id,queue_task_id having bool_or('embeddings_v1'=any(task_types));
revoke all on public.factory_metric_events from public,anon,authenticated;

create function public.factory_metric_matches(p_dataset_id bigint,p_filters jsonb)
returns boolean language sql stable set search_path='' as $$
 select
 (coalesce(p_filters->>'workflow','all')='all' or coalesce(m.workflow,case when lower(d.file_name) like '%.zip' then 'odm' else 'geotiff' end)=p_filters->>'workflow')
 and (coalesce(p_filters->>'size','all')='all'
   or (p_filters->>'size'='small' and m.input_bytes<1073741824)
   or (p_filters->>'size'='large' and m.input_bytes>=1073741824)
   or (p_filters->>'size'='unknown' and m.input_bytes is null))
 and (not p_filters ? 'metric' or case p_filters->>'metric'
   when 'waiting' then m.dataset_id is not null and m.first_ready_at is null
   when 'failed_submission' then m.dataset_id is not null and m.first_ready_at is null and s.has_error
   when 'overdue' then m.first_ready_at is null and m.workflow='geotiff' and m.input_bytes<1073741824 and m.uploaded_at<now()-interval '2 hours'
   when 'unresolved_failure' then exists(select 1 from public.factory_failure_episodes f where f.dataset_id=d.id and f.recovered_at is null)
   else exists(select 1 from public.factory_metric_events e where e.dataset_id=d.id and e.metric=p_filters->>'metric'
    and (not p_filters ? 'metric_after' or e.happened_at>=(p_filters->>'metric_after')::timestamptz)
    and (not p_filters ? 'metric_before' or e.happened_at<(p_filters->>'metric_before')::timestamptz)) end)
 from public.v2_datasets d left join public.factory_submissions m on m.dataset_id=d.id
 left join public.v2_statuses s on s.dataset_id=d.id where d.id=p_dataset_id;
$$;
revoke all on function public.factory_metric_matches(bigint,jsonb) from public,anon,authenticated;

create or replace function public.factory_filtered_datasets(p_filters jsonb)
returns setof public.factory_dataset_records
language sql stable set search_path = '' as $$
  select r.* from public.factory_dataset_records r
  where public.factory_metric_matches(r.dataset_id,p_filters)
  and (coalesce(p_filters->>'archived','no')='all'
    or r.archived=(coalesce(p_filters->>'archived','no')='yes'))
  and (coalesce(p_filters->>'search','')='' or concat_ws(' ',r.dataset_id::text,r.file_name,r.user_email,r.organisation)
    ilike '%' || (p_filters->>'search') || '%')
  and (coalesce(p_filters->>'state','all')='all' or r.state=p_filters->>'state')
  and (coalesce(p_filters->>'worker','')='' or r.worker_id=p_filters->>'worker')
  and (coalesce(p_filters->>'contributor','')='' or r.user_id=(p_filters->>'contributor')::uuid)
  and (not p_filters ? 'created_after' or r.created_at >= (p_filters->>'created_after')::timestamptz)
  and (not p_filters ? 'created_before' or r.created_at < (p_filters->>'created_before')::timestamptz)
  and (not p_filters ? 'ids' or r.dataset_id in (select value::bigint from jsonb_array_elements_text(p_filters->'ids')))
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
    or r.has_error or r.notification_problem or r.open_reports>0 or r.state='uncertain');
$$;

create function public.factory_trends(p_interval text default 'week',p_workflow text default 'all',p_size text default 'all')
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' as $$
declare result jsonb; epoch timestamptz; start_at timestamptz; step interval; filters jsonb;
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 if p_interval is null or p_interval not in ('day','week') or p_workflow is null or p_workflow not in ('all','geotiff','odm') or p_size is null or p_size not in ('all','small','large','unknown') then
 raise exception 'Invalid Factory trend filters' using errcode='22023'; end if;
 select started_at into epoch from public.factory_measurement_epoch;
 step:=case p_interval when 'week' then interval '1 week' else interval '1 day' end;
 start_at:=(date_trunc(p_interval,now() at time zone 'UTC')-step*(case p_interval when 'week' then 11 else 27 end)) at time zone 'UTC';
 filters:=jsonb_build_object('workflow',p_workflow,'size',p_size);
 with population as materialized (
   select d.id,d.user_id,s.has_error,s.is_upload_done,m.uploaded_at,m.first_ready_at,m.input_bytes,m.workflow,
    extract(epoch from(m.first_ready_at-m.uploaded_at))/3600.0 as lead_hours
   from public.v2_datasets d left join public.factory_submissions m on m.dataset_id=d.id
   left join public.v2_statuses s on s.dataset_id=d.id where public.factory_metric_matches(d.id,filters)
 ), failures as materialized (
   select f.*,extract(epoch from(f.recovered_at-f.failed_at))/3600.0 as recovery_hours
   from public.factory_failure_episodes f join population p on p.id=f.dataset_id
 ), events as materialized (
   select e.* from public.factory_metric_events e join population p on p.id=e.dataset_id where e.happened_at>=start_at and e.happened_at<=now()
 ), buckets as (
   select t as start,t+step as finish,t+step>now() or (epoch>t and epoch<t+step) as partial,t+step>epoch as measured
   from generate_series(start_at,date_trunc(p_interval,now() at time zone 'UTC') at time zone 'UTC',step) t
 ), series as (
 select b.start,b.finish as "end",b.partial,b.measured,
   case when measured then (select count(*) from events e where e.metric='uploaded' and e.happened_at>=b.start and e.happened_at<b.finish) end as uploaded,
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
   (select count(*) from events e where e.metric='registered' and e.happened_at>=b.start and e.happened_at<b.finish) as registered,
   (select count(*) from events e where e.metric='recorded_completed' and e.happened_at>=b.start and e.happened_at<b.finish) as recorded_completed,
   (select count(*) from events e where e.metric='recorded_failed' and e.happened_at>=b.start and e.happened_at<b.finish) as recorded_failed,
   (select count(*) from events e where e.metric='recorded_embedding_completed' and e.happened_at>=b.start and e.happened_at<b.finish) as recorded_embedding_completed
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
revoke all on function public.factory_trends(text,text,text) from public,anon;
grant execute on function public.factory_trends(text,text,text) to authenticated;
notify pgrst,'reload schema';
commit;
