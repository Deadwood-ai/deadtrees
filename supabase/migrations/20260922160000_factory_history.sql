-- Retained historical evidence stays separate from prospective first-result facts.
begin;
-- Restrict reconstruction to the documented upload-success event, not every log.
create index factory_upload_success_log_idx on public.v2_logs(dataset_id,created_at,id)
 where category='upload' and message like 'Upload completed successfully for dataset %';
create view public.factory_historical_uploads with(security_invoker=true) as
 with logged as (
  select distinct on(l.dataset_id) l.dataset_id,l.created_at,
   case when l.extra->>'file_size' ~ '^[0-9]{1,18}$' then nullif((l.extra->>'file_size')::bigint,0) end as input_bytes
  from public.v2_logs l join public.v2_datasets d on d.id=l.dataset_id
  where l.category='upload' and l.message like 'Upload completed successfully for dataset %'
   and l.created_at>=d.created_at and l.created_at<=now()
  order by l.dataset_id,l.created_at,l.id
 )
 select d.id as dataset_id,d.user_id,coalesce(m.uploaded_at,l.created_at) as uploaded_at,
  case when m.dataset_id is not null then m.input_bytes else l.input_bytes end as input_bytes,
  case when m.dataset_id is not null then 'measured' else 'upload_log' end as source
 from public.v2_datasets d left join public.factory_submissions m on m.dataset_id=d.id
 left join logged l on l.dataset_id=d.id
 where m.dataset_id is not null or l.dataset_id is not null;
create view public.factory_historical_runs with(security_invoker=true) as
 select dataset_id,queue_task_id,event_type,min(created_at) as happened_at,
  bool_or('embeddings_v1'=any(task_types)) as with_indexing
 from public.processing_notification_events
 where event_type in ('processing_completed','processing_failed') and created_at<=now()
 group by dataset_id,queue_task_id,event_type;
create view public.factory_historical_timing with(security_invoker=true) as
 select u.*,c.completed_at,
  extract(epoch from(c.completed_at-u.uploaded_at))/3600.0 as elapsed_hours
 from public.factory_historical_uploads u join (
  select dataset_id,min(happened_at) as completed_at from public.factory_historical_runs
  where event_type='processing_completed' group by dataset_id
 ) c using(dataset_id) where c.completed_at>=u.uploaded_at;
revoke all on public.factory_historical_uploads,public.factory_historical_runs,public.factory_historical_timing from public,anon,authenticated;
create or replace view public.factory_metric_events with(security_invoker=true) as
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
 group by dataset_id,queue_task_id having bool_or('embeddings_v1'=any(task_types))
 union all select dataset_id,'historical_uploaded',uploaded_at from public.factory_historical_uploads
 union all select dataset_id,'historical_completion',completed_at from public.factory_historical_timing
 union all select dataset_id,'historical_report',created_at from public.dataset_flags
 union all select dataset_id,'historical_email',sent_at from public.processing_notification_events where status='sent' and sent_at is not null;

create function public.factory_history(p_year integer default null)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set jit=off as $$
declare result jsonb; first_at timestamptz; start_at timestamptz; end_at timestamptz;
 step interval; grain text;
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 if p_year is not null and (p_year<1970 or p_year>extract(year from now())) then
  raise exception 'Invalid history year' using errcode='22023'; end if;
 select min(created_at) into first_at from public.v2_datasets where created_at<=now();
 start_at:=case when p_year is null then date_trunc('year',coalesce(first_at,now())) else make_timestamptz(p_year,1,1,0,0,0,'UTC') end;
 end_at:=case when p_year is null then now() else least(start_at+interval '1 year',now()) end;
 grain:=case when p_year is null then 'year' else 'month' end;
 step:=case when p_year is null then interval '1 year' else interval '1 month' end;
 with uploads as materialized(select * from public.factory_historical_uploads),
 runs as materialized(select * from public.factory_historical_runs),
 -- Same pairing contract as factory_historical_timing; use materialized inputs here
 -- to avoid repeated scans (50k benchmark: 2.56s -> 1.68s). DB tests compare both paths.
 timing as materialized(
  select u.*,c.completed_at,extract(epoch from(c.completed_at-u.uploaded_at))/3600.0 as elapsed_hours
  from uploads u join (select dataset_id,min(happened_at) as completed_at from runs
   where event_type='processing_completed' group by dataset_id) c using(dataset_id)
  where c.completed_at>=u.uploaded_at
 ), bounds as (select (select min(uploaded_at) from uploads) as upload_since,(select min(happened_at) from runs) as run_since,
  (select min(created_at) from public.dataset_flags where created_at<=now()) as report_since,
  (select min(published_at) from public.data_publication where status='published' and published_at<=now()) as publication_since,
  (select min(sent_at) from public.processing_notification_events where status='sent' and sent_at<=now()) as email_since),
 -- Event counts use their own unit: datasets, runs, recipient deliveries, reports, publications.
 events as (
  select created_at as at,'registered'::text as kind from public.v2_datasets
  union all select uploaded_at,'uploaded' from uploads
  union all select happened_at,case when event_type='processing_completed' then 'completed' else 'failed' end from runs
  union all select happened_at,'indexing' from runs where event_type='processing_completed' and with_indexing
  union all select sent_at,'emails' from public.processing_notification_events where status='sent' and sent_at is not null
  union all select created_at,'reports' from public.dataset_flags
  union all select published_at,'publications' from public.data_publication where status='published' and published_at is not null
 ), totals as (
  select date_trunc(grain,at) as bucket,
   count(*) filter(where kind='registered') as registered,count(*) filter(where kind='uploaded') as uploaded,
   count(*) filter(where kind='completed') as completed,count(*) filter(where kind='failed') as failed,
   count(*) filter(where kind='indexing') as indexing,count(*) filter(where kind='emails') as emails,
   count(*) filter(where kind='reports') as reports,count(*) filter(where kind='publications') as publications
  from events where at>=start_at and at<end_at group by 1
 ), elapsed as (
  select date_trunc(grain,completed_at) as bucket,count(*) as samples,
   percentile_cont(0.5) within group(order by elapsed_hours) as p50,
   percentile_cont(0.9) within group(order by elapsed_hours) as p90
  from timing where completed_at>=start_at and completed_at<end_at group by 1
 ), first_uploads as (select user_id,min(uploaded_at) as first_at from uploads group by user_id),
 volume as (
  select date_trunc(grain,u.uploaded_at) as bucket,sum(u.input_bytes)/1073741824.0 as input_gib,
   count(u.input_bytes) as size_samples,count(distinct u.user_id) as contributors,
   count(distinct u.user_id) filter(where f.first_at<date_trunc(grain,u.uploaded_at)) as returning_contributors
  from uploads u join first_uploads f using(user_id) where u.uploaded_at>=start_at and u.uploaded_at<end_at group by 1
 ), buckets as (select t as start,least(t+step,end_at) as finish from generate_series(start_at,end_at,step) t where t<end_at),
 series as (
  select b.start,b.finish as "end",b.start+step>now() as partial,coalesce(t.registered,0) as registered,
   case when b.finish>upload_since then coalesce(t.uploaded,0) end as uploaded,
   case when b.finish>run_since then coalesce(t.completed,0) end as completed,
   case when b.finish>run_since then coalesce(t.failed,0) end as failed,
   case when b.finish>run_since then coalesce(t.indexing,0) end as indexing,
   case when b.finish>email_since then coalesce(t.emails,0) end as emails,
   case when b.finish>report_since then coalesce(t.reports,0) end as reports,
   case when b.finish>publication_since then coalesce(t.publications,0) end as publications,
   v.input_gib,coalesce(v.size_samples,0) as size_samples,
   case when b.finish>upload_since then coalesce(v.contributors,0) end as contributors,
   case when b.finish>upload_since then coalesce(v.returning_contributors,0) end as returning_contributors,
   e.p50,e.p90,coalesce(e.samples,0) as timing_samples
  from buckets b cross join bounds left join totals t on t.bucket=b.start left join elapsed e on e.bucket=b.start left join volume v on v.bucket=b.start
 )
 select jsonb_build_object('as_of',now(),'first_registration',first_at,'year',p_year,
  'years',(select jsonb_agg(y order by y desc) from generate_series(extract(year from coalesce(first_at,now()))::integer,extract(year from now())::integer) y),
  'upload_since',(select upload_since from bounds),'run_since',(select run_since from bounds),
  'report_since',(select report_since from bounds),'publication_since',(select publication_since from bounds),'email_since',(select email_since from bounds),
  'coverage',jsonb_build_object('datasets',(select count(*) from public.v2_datasets),
   'upload_evidence',(select count(*) from uploads),'upload_sizes',(select count(input_bytes) from uploads),
   'timing_pairs',(select count(*) from timing),
   'measured_uploads',(select count(*) from uploads where source='measured'),
   'ready_now',(select count(*) from public.v2_datasets d join public.v2_statuses s on s.dataset_id=d.id where not d.archived and public.factory_status_ready(s,d.file_name))),
  'series',coalesce((select jsonb_agg(to_jsonb(series) order by start) from series),'[]'::jsonb)) into result;
 return result;
end;
$$;
revoke all on function public.factory_history(integer) from public,anon;
grant execute on function public.factory_history(integer) to authenticated;
create or replace function public.factory_dataset(p_dataset_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' set jit=off as $$
declare dataset jsonb; result jsonb;
begin
  if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
  select to_jsonb(r) into dataset from public.factory_dataset_records r where dataset_id=p_dataset_id;
  if dataset is null then return jsonb_build_object('as_of',now(),'dataset',null); end if;
  select jsonb_build_object('as_of',now(),'dataset',dataset,
    'status',(select to_jsonb(s) || coalesce(to_jsonb(m)-'dataset_id','{}'::jsonb)
      || coalesce((select jsonb_build_object('historical_uploaded_at',u.uploaded_at,'historical_input_bytes',u.input_bytes,'historical_upload_source',u.source)
        from public.factory_historical_uploads u where u.dataset_id=p_dataset_id),'{}'::jsonb)
      || coalesce((select jsonb_build_object('historical_completed_at',t.completed_at,'historical_elapsed_hours',t.elapsed_hours)
        from public.factory_historical_timing t where t.dataset_id=p_dataset_id),'{}'::jsonb)
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
-- Keep historical evidence branches out of the prospective chart aggregation.
create or replace function public.factory_trends(p_interval text default 'week',p_workflow text default 'all',p_size text default 'all')
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set jit=off as $$
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
   where e.metric in ('uploaded','first_ready','failures','recovered','registered','recorded_completed','recorded_failed','recorded_embedding_completed')
    and e.happened_at>=start_at and e.happened_at<=now() group by 1,2
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
notify pgrst,'reload schema';
commit;
