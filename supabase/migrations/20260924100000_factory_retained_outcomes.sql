-- Outcome charts from retained evidence. Directly measured facts keep precedence;
-- processor logs reconstruct earlier first results, failures and recoveries, and
-- every value says which source it came from. Failures and recoveries are now
-- observed for every dataset, not only registrations after instrumentation.
begin;

-- Pipeline position of a processor stage, by task type or by the stage name that
-- failure and crash logs use. Stages run in this order within a run. A pure
-- expression without a SET clause, so it inlines into the per-row log scans.
create function public.factory_stage_position(p_stage text) returns integer
language sql immutable as $$
 select case p_stage
  when 'odm_processing' then 1
  when 'geotiff' then 2 when 'ortho_processing' then 2 when 'geotiff_dependency' then 2
  when 'metadata' then 3 when 'metadata_processing' then 3
  when 'cog' then 4 when 'cog_processing' then 4
  when 'thumbnail' then 5 when 'thumbnail_processing' then 5
  when 'deadwood' then 6 when 'deadwood_v1' then 6 when 'deadwood_segmentation' then 6
  when 'treecover' then 7 when 'treecover_v1' then 7 when 'treecover_segmentation' then 7 when 'forest_cover_segmentation' then 7
  when 'deadwood_treecover_combined_v2' then 8 when 'deadwood_treecover_combined_segmentation' then 8
  when 'aoi_v1' then 9 when 'aoi_segmentation' then 9
  when 'embeddings_v1' then 10 when 'embedding_processing' then 10 end;
$$;

-- Processor-run log evidence (INFO logs retained from 2025-10-31), numbered into
-- runs: a start log opens a run and records its requested task types. The
-- predicate matches factory_run_log_idx (migration 20260924090000).
create view public.factory_run_log_events with(security_invoker=true) as
 with evidence as (
  select dataset_id,created_at,id,
   case when message like 'Starting processing for task %' then 'start'
    when message like 'Processing failed:%' or message like 'Crash detected for dataset %' then 'failed'
    when message like 'Received signal %' then 'interrupted' else 'success' end as kind,
   -- Success position, or the position of the stage a failure names.
   case when message like 'Processing failed:%' then public.factory_stage_position(substring(message from 'Processing failed: ([a-z_]+)'))
    when message like 'Crash detected for dataset %' then public.factory_stage_position(substring(message from 'crashed during ([a-z_]+)'))
    -- A completed run's notification record proves every requested stage.
    when message like 'Recorded % processing_completed notification event(s) for task %' then 11
    -- ODM counts only after its outputs are stored and is_odm_done is set; the bare
    -- message is logged at container exit, before extraction and upload can fail.
    when message like 'ODM processing completed successfully for dataset %' then 1
    when message like 'Finished converting dataset %' then 2
    when message='Processed metadata successfully' then 3
    when message='Thumbnail processing completed successfully' then 5
    when message='Deadwood segmentation completed successfully' then 6
    when message='Tree cover segmentation completed successfully' then 7
    when message='Combined segmentation completed successfully' then 8
    when message='AOI segmentation completed successfully' then 9
    when message='Tile embedding completed successfully' then 10 end as position,
   -- Requested stage positions, from the task types a start log records.
   case when message like 'Starting processing for task %' then array(select public.factory_stage_position(t)
    from jsonb_array_elements_text(case when jsonb_typeof(extra->'task_types')='array' then extra->'task_types' else '[]'::jsonb end) t) end as requested
  from public.v2_logs where dataset_id is not null and (
   (category='process' and (message like 'Starting processing for task %' or message like 'Processing failed:%'
    or message like 'Crash detected for dataset %' or message like 'Received signal %; gracefully re-queuing in-flight task %'
    or message like 'Recorded % processing_completed notification event(s) for task %'))
   or (category='ortho' and message like 'Finished converting dataset %')
   or (category='odm' and message like 'ODM processing completed successfully for dataset %')
   or message in ('Combined segmentation completed successfully','Tree cover segmentation completed successfully',
    'Deadwood segmentation completed successfully','AOI segmentation completed successfully','Processed metadata successfully',
    'Thumbnail processing completed successfully','Tile embedding completed successfully'))
   and created_at<=now()
 )
 select *,count(*) filter(where kind='start') over(partition by dataset_id order by created_at,id) as run from evidence;

-- Stage evidence over time. Stages run in pipeline order and a failing stage ends
-- its run, so the first success at or past a requested stage proves it ('proof');
-- a later failure in the same run does not undo it. ODM counts only from its final
-- dataset-specific message; COG has no success log and is proven by a later stage
-- or the run's completed-notification record. Requeueing a failed dataset resets
-- the done flags of the requested stages, so a run that follows a failed run
-- invalidates earlier proofs of its requested stages at its start ('reset'). A run
-- requesting an area of interest makes it a lasting requirement ('aoi_required').
create view public.factory_stage_proofs with(security_invoker=true) as
 with events as materialized (
  select dataset_id,run,created_at,kind,position,
   first_value(requested) over run_order as run_requested,
   first_value(created_at) over run_order as run_started_at,
   max(position) filter(where kind='success') over(run_order rows between unbounded preceding and 1 preceding) as reached,
   bool_or(kind='failed') over(partition by dataset_id,run) as run_failed
  from public.factory_run_log_events where run>0
  window run_order as(partition by dataset_id,run order by created_at,id)
 ), starts as (
  select dataset_id,run_started_at,run_requested,
   coalesce(lag(run_failed) over(partition by dataset_id order by run),false) as after_failure
  from events where kind='start'
 )
 select e.dataset_id,e.run_started_at,p.position,e.created_at as at,'proof'::text as event
 from events e cross join lateral generate_series(coalesce(e.reached,0)+1,e.position) p(position)
 where e.kind='success' and e.position>coalesce(e.reached,0) and p.position=any(e.run_requested)
 union all
 select dataset_id,run_started_at,p.position,run_started_at,'reset'
 from starts cross join lateral unnest(run_requested) p(position) where after_failure and p.position is not null
 union all
 select dataset_id,run_started_at,9,run_started_at,'aoi_required' from starts where 9=any(run_requested);

-- Moments at which full readiness held, as factory_status_ready defines it: ODM for
-- ZIPs, ortho, metadata, COG, thumbnail, deadwood and forest cover (the combined
-- model or both legacy models), and the area of interest once required. Readiness
-- can only begin at a proof, so each proof time is checked against the proofs still
-- valid then (not yet reset). Unproven requirements never yield a moment.
create view public.factory_ready_moments with(security_invoker=true) as
 with evidence as materialized (select * from public.factory_stage_proofs),
 valid as (
  select dataset_id,position,at as valid_from,valid_to from (
   select dataset_id,position,event,at,
    -- A reset happens at its run's start, before that run's own proofs.
    min(at) filter(where event='reset') over(partition by dataset_id,position order by at,event='proof'
     rows between 1 following and unbounded following) as valid_to
   from evidence where event in('proof','reset')) x
  where event='proof'
 ), candidates as (
  select distinct dataset_id,at from evidence where event='proof'
 ), coverage as (
  select c.dataset_id,c.at,
   bool_or(v.position=1) as odm,bool_or(v.position=2) as ortho,bool_or(v.position=3) as metadata,
   bool_or(v.position=4) as cog,bool_or(v.position=5) as thumbnail,bool_or(v.position=6) as deadwood,
   bool_or(v.position=7) as forest_cover,bool_or(v.position=8) as combined,bool_or(v.position=9) as aoi
  from candidates c join valid v on v.dataset_id=c.dataset_id and v.valid_from<=c.at and (v.valid_to is null or c.at<v.valid_to)
  group by c.dataset_id,c.at
 ), aoi as (
  select dataset_id,min(at) as required_since from evidence where event='aoi_required' group by dataset_id
 )
 select c.dataset_id,c.at as ready_at
 from coverage c join public.v2_datasets d on d.id=c.dataset_id left join aoi a on a.dataset_id=c.dataset_id
 where (lower(d.file_name) not like '%.zip' or c.odm) and c.ortho and c.metadata and c.cog and c.thumbnail
  and (c.combined or (c.deadwood and c.forest_cover))
  and (a.required_since is null or a.required_since>c.at or c.aoi);

-- Earliest retained processor run. Uploads before it may already have had results
-- whose runs were not retained, so their first retained result could be a rerun.
create function public.factory_run_evidence_since() returns timestamptz
language sql stable set search_path='' as $$
 select min(created_at) from public.v2_logs
 where dataset_id is not null and category='process' and message like 'Starting processing for task %';
$$;
revoke all on function public.factory_run_evidence_since(),public.factory_stage_position(text) from public,anon,authenticated;

-- One upload and first-result record per dataset with upload evidence. Measured
-- submissions are authoritative, including while they still wait; otherwise the
-- first result is the first ready moment after the upload, for
-- uploads within the retained processor-run evidence. Unprovable stays unknown.
create view public.factory_outcome_evidence with(security_invoker=true) as
 select u.dataset_id,u.user_id,u.uploaded_at,u.source as upload_source,u.input_bytes,
  case when lower(d.file_name) like '%.zip' then 'odm' else 'geotiff' end as workflow,
  case when m.dataset_id is not null then m.first_ready_at else r.first_result_at end as first_result_at,
  case when m.dataset_id is not null then case when m.first_ready_at is not null then 'measured' end
   when r.first_result_at is not null then 'processing_log' end as result_source
 from public.factory_historical_uploads u
 join public.v2_datasets d on d.id=u.dataset_id
 left join public.factory_submissions m on m.dataset_id=u.dataset_id
 left join (
  select m.dataset_id,min(m.ready_at) as first_result_at
  from public.factory_ready_moments m join public.factory_historical_uploads pu on pu.dataset_id=m.dataset_id and m.ready_at>=pu.uploaded_at
  group by m.dataset_id
 ) r on r.dataset_id=u.dataset_id and u.uploaded_at>=public.factory_run_evidence_since();

-- Observe failures and recoveries for every dataset from now on. Datasets that
-- are already failing get an open episode whose start was not observed (seeded
-- below, once the failure evidence view exists).
alter table public.factory_measurement_epoch add column failures_started_at timestamptz not null default clock_timestamp();
alter table public.factory_failure_episodes drop constraint factory_failure_episodes_dataset_id_fkey,
 add constraint factory_failure_episodes_dataset_id_fkey foreign key(dataset_id) references public.v2_datasets(id) on delete cascade,
 alter column failed_at drop not null, alter column failed_at drop default;
comment on column public.factory_failure_episodes.failed_at is 'Null when the dataset was already failing when every dataset became observed (factory_measurement_epoch.failures_started_at).';
create or replace function public.factory_observe_status() returns trigger
language plpgsql security definer set search_path='' as $$
declare d public.v2_datasets; observed_at timestamptz := clock_timestamp();
begin
 select * into d from public.v2_datasets where id=new.dataset_id;
 -- Old datasets, including reuploads and reruns, cannot acquire invented first
 -- upload times. Upload coverage begins only for registrations after instrumentation.
 if d.created_at>=(select started_at from public.factory_measurement_epoch)
  and new.is_upload_done and (tg_op='INSERT' or not old.is_upload_done) then
   insert into public.factory_submissions(dataset_id,uploaded_at,workflow,input_bytes)
   values(new.dataset_id,observed_at,case when lower(d.file_name) like '%.zip' then 'odm' else 'geotiff' end,new.uploaded_input_bytes)
   on conflict(dataset_id) do nothing;
 end if;
 if new.has_error and (tg_op='INSERT' or not old.has_error) then
   insert into public.factory_failure_episodes(dataset_id,failed_at) values(new.dataset_id,observed_at)
   on conflict(dataset_id) where recovered_at is null do nothing;
 end if;
 if public.factory_status_ready(new,d.file_name) then
   update public.factory_submissions set first_ready_at=observed_at where dataset_id=new.dataset_id and first_ready_at is null;
   -- Clearing an error alone is not recovery: the whole readiness rule must pass.
   update public.factory_failure_episodes set recovered_at=observed_at where dataset_id=new.dataset_id and recovered_at is null;
 end if;
 return new;
end;
$$;

-- Failure episodes from every source. The ledger owns a dataset from the moment
-- it is observed. Before that, failures come from processor logs and an episode
-- ends only when the evidence shows the dataset complete again, comparable to the
-- ledger's full readiness: a later run proved the failed stage and every readiness
-- requirement is proven. A failure naming no known stage stays open. Failures
-- before that point belong to the same episode. An episode still open when
-- observation began continues in the ledger's open row, which then supplies the
-- measured recovery.
create view public.factory_failure_evidence with(security_invoker=true) as
 with epoch as (select failures_started_at as observed_from from public.factory_measurement_epoch),
 moments as materialized (select * from public.factory_ready_moments),
 ready as (
  select dataset_id,min(ready_at) as first_ready_at from moments group by dataset_id
 ), failures as (
  select dataset_id,id,created_at as failed_at,position as failed_position,
   lead(created_at) over(partition by dataset_id order by created_at,id) as next_failed_at
  from public.factory_run_log_events where kind='failed'
 ), reproofs as (
  select f.dataset_id,f.id,min(p.at) as reproved_at
  from failures f join public.factory_stage_proofs p on p.dataset_id=f.dataset_id and p.event='proof'
   and p.position=f.failed_position and p.run_started_at>f.failed_at
  group by f.dataset_id,f.id
 ), complete_again as (
  -- A run started after the failure proved the failed stage, and full readiness
  -- held then or later, before any further failure.
  select rp.dataset_id,rp.id,min(m.ready_at) as recovered_at
  from reproofs rp join failures f on f.dataset_id=rp.dataset_id and f.id=rp.id
  join moments m on m.dataset_id=rp.dataset_id and m.ready_at>=rp.reproved_at
   and (f.next_failed_at is null or m.ready_at<f.next_failed_at)
  group by rp.dataset_id,rp.id
 ), recovered as (
  select f.dataset_id,f.id,f.failed_at,c.recovered_at
  from failures f left join complete_again c on c.dataset_id=f.dataset_id and c.id=f.id
 ), episodes_logged as (
  select *,count(*) filter(where opens) over(partition by dataset_id order by failed_at,id) as episode
  from (select *,coalesce(lag(recovered_at) over(partition by dataset_id order by failed_at,id) is not null,true) as opens from recovered) o
 ), logged as (
  select g.dataset_id,min(g.failed_at) as failed_at,max(g.recovered_at) as recovered_at,
   row_number() over(partition by g.dataset_id order by min(g.failed_at) desc)=1
    and (max(g.recovered_at) is null or max(g.recovered_at)>=max(e.observed_from)) as open_when_observed
  from episodes_logged g cross join epoch e
  where g.failed_at<e.observed_from
   and not exists(select 1 from public.factory_submissions m where m.dataset_id=g.dataset_id)
  group by g.dataset_id,g.episode
 ), carried as (
  select dataset_id,recovered_at from public.factory_failure_episodes where failed_at is null
 ), episodes as (
  select dataset_id,failed_at,recovered_at,'processing_log'::text as start_source,
   case when recovered_at is not null then 'processing_log' end as recovery_source
  from logged where not open_when_observed
  union all
  select coalesce(l.dataset_id,c.dataset_id),l.failed_at,
   case when c.dataset_id is null then l.recovered_at else c.recovered_at end,
   case when l.dataset_id is not null then 'processing_log' end,
   case when c.dataset_id is null then case when l.recovered_at is not null then 'processing_log' end
    when c.recovered_at is not null then 'measured' end
  from (select * from logged where open_when_observed) l full join carried c on c.dataset_id=l.dataset_id
  union all
  select dataset_id,failed_at,recovered_at,'measured',case when recovered_at is not null then 'measured' end
  from public.factory_failure_episodes where failed_at is not null
 )
 -- Phase: still waiting for the first complete result, or a rerun of a dataset that
 -- had one. Measured readiness decides for measured submissions, as in the outcome
 -- evidence; otherwise proven readiness before the failure does. Without upload
 -- evidence or proven earlier readiness the phase stays unknown.
 select x.dataset_id,x.failed_at,x.recovered_at,x.start_source,x.recovery_source,
  case when x.failed_at is null then 'unknown'
   when m.dataset_id is not null then case when m.first_ready_at<x.failed_at then 'rerun' else 'first_result' end
   when r.first_ready_at<x.failed_at then 'rerun'
   when exists(select 1 from public.factory_historical_uploads u where u.dataset_id=x.dataset_id) then 'first_result'
   else 'unknown' end as phase
 from episodes x left join public.factory_submissions m on m.dataset_id=x.dataset_id
 left join ready r on r.dataset_id=x.dataset_id;

revoke all on public.factory_run_log_events,public.factory_stage_proofs,public.factory_ready_moments,public.factory_outcome_evidence,public.factory_failure_evidence from public,anon,authenticated;

-- Carry every failure still open when observation begins into the ledger: datasets
-- with the error flag, and datasets whose retained failure has no recovery evidence
-- and that are not complete now. A requeue clears the error flag before its retry
-- finishes, so the flag alone would miss a retry running during deployment; the
-- open row then keeps it open now and absorbs a failing retry instead of a second
-- episode. Datasets complete now are not carried: they recovered, even if no log
-- proves when. Returns the number of rows carried.
create function public.factory_carry_open_failures() returns integer
language sql volatile security definer set search_path='' as $$
 with carried as (
  insert into public.factory_failure_episodes(dataset_id,failed_at)
  select s.dataset_id,null from public.v2_statuses s join public.v2_datasets d on d.id=s.dataset_id
  where (s.has_error or (not public.factory_status_ready(s,d.file_name) and exists(
    select 1 from public.factory_failure_evidence e where e.dataset_id=s.dataset_id
     and e.start_source='processing_log' and e.recovered_at is null)))
   and not exists(select 1 from public.factory_failure_episodes f where f.dataset_id=s.dataset_id and f.recovered_at is null)
  returning 1
 ) select count(*)::integer from carried;
$$;
revoke all on function public.factory_carry_open_failures() from public,anon,authenticated;
select public.factory_carry_open_failures();

-- Chart drilldowns list exactly the datasets behind each plotted evidence count.
create or replace view public.factory_metric_events with(security_invoker=true) as
 select dataset_id,'uploaded'::text as metric,uploaded_at as happened_at from public.factory_historical_uploads
 union all select dataset_id,'first_ready',first_result_at from public.factory_outcome_evidence where first_result_at is not null
 union all select dataset_id,'failures',failed_at from public.factory_failure_evidence where failed_at is not null
 union all select dataset_id,'first_result_failures',failed_at from public.factory_failure_evidence where failed_at is not null and phase='first_result'
 union all select dataset_id,'recovered',recovered_at from public.factory_failure_evidence where recovered_at is not null
 union all select id,'registered',created_at from public.v2_datasets
 union all select dataset_id,case event_type when 'processing_completed' then 'recorded_completed' else 'recorded_failed' end,min(created_at)
 from public.processing_notification_events where event_type in ('processing_completed','processing_failed')
 group by dataset_id,queue_task_id,event_type
 union all select dataset_id,'recorded_embedding_completed',min(created_at)
 from public.processing_notification_events where event_type='processing_completed'
 group by dataset_id,queue_task_id having bool_or('embeddings_v1'=any(task_types))
 union all select dataset_id,'historical_report',created_at from public.dataset_flags
 union all select dataset_id,'historical_email',sent_at from public.processing_notification_events where status='sent' and sent_at is not null;
drop view public.factory_historical_timing;

-- Workflow and size follow the same evidence as the charts, so every chart link
-- opens the same population. Sizes come from measurement or upload logs.
create or replace function public.factory_filtered_datasets(p_filters jsonb)
returns setof public.factory_attention_records
language sql stable as $$
  select r.* from public.factory_attention_records r
  left join public.factory_submissions m on m.dataset_id=r.dataset_id
  where (coalesce(p_filters->>'workflow','all')='all' or case when lower(r.file_name) like '%.zip' then 'odm' else 'geotiff' end=p_filters->>'workflow')
  and (coalesce(p_filters->>'size','all')='all'
    or (p_filters->>'size'='unknown' and r.dataset_id not in(select u.dataset_id from public.factory_historical_uploads u where u.input_bytes is not null))
    or r.dataset_id in(select u.dataset_id from public.factory_historical_uploads u
     where (p_filters->>'size'='small' and u.input_bytes<1073741824) or (p_filters->>'size'='large' and u.input_bytes>=1073741824)))
  and (not p_filters ? 'metric' or case p_filters->>'metric'
    when 'waiting' then not r.is_ready and r.dataset_id in(select e.dataset_id from public.factory_outcome_evidence e where e.first_result_at is null)
    when 'failed_submission' then not r.is_ready and r.has_error and r.dataset_id in(select e.dataset_id from public.factory_outcome_evidence e where e.first_result_at is null)
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

create or replace function public.factory_trends(p_interval text default 'week',p_workflow text default 'all',p_size text default 'all')
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set jit=off as $$
declare result jsonb; epoch timestamptz; failures_epoch timestamptz; upload_since timestamptz; run_since timestamptz;
 start_at timestamptz; step interval;
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 if p_interval is null or p_interval not in ('day','week','month') or p_workflow is null or p_workflow not in ('all','geotiff','odm')
  or p_size is null or p_size not in ('all','small','large','unknown') then
  raise exception 'Invalid Factory trend filters' using errcode='22023'; end if;
 select started_at,failures_started_at into epoch,failures_epoch from public.factory_measurement_epoch;
 -- Periods before the first retained evidence are unknown, not zero.
 select min(uploaded_at) into upload_since from public.factory_historical_uploads;
 run_since:=least(epoch,public.factory_run_evidence_since());
 step:=case p_interval when 'month' then interval '1 month' when 'week' then interval '1 week' else interval '1 day' end;
 start_at:=date_trunc(p_interval,now())-step*(case p_interval when 'day' then 27 else 11 end);
 with population as materialized (
  select e.*,d.archived,coalesce(s.has_error,false) as has_error,coalesce(public.factory_status_ready(s,d.file_name),false) as ready_now,
   extract(epoch from(e.first_result_at-e.uploaded_at))/3600.0 as lead_hours
  from public.factory_outcome_evidence e join public.v2_datasets d on d.id=e.dataset_id
  left join public.v2_statuses s on s.dataset_id=e.dataset_id
  where (p_workflow='all' or e.workflow=p_workflow)
   and (p_size='all' or (p_size='small' and e.input_bytes<1073741824) or (p_size='large' and e.input_bytes>=1073741824) or (p_size='unknown' and e.input_bytes is null))
 ), failures as materialized (
  -- Open now follows the ledger, which keeps an episode open through retries (a
  -- requeue clears the error flag) until full readiness, like the explorer link.
  select f.*,d.archived,extract(epoch from(f.recovered_at-f.failed_at))/3600.0 as recovery_hours,
   exists(select 1 from public.factory_failure_episodes o where o.dataset_id=f.dataset_id and o.recovered_at is null) as open_now
  from public.factory_failure_evidence f join public.v2_datasets d on d.id=f.dataset_id
  left join public.factory_historical_uploads u on u.dataset_id=f.dataset_id
  where (p_workflow='all' or case when lower(d.file_name) like '%.zip' then 'odm' else 'geotiff' end=p_workflow)
   and (p_size='all' or (p_size='small' and u.input_bytes<1073741824) or (p_size='large' and u.input_bytes>=1073741824) or (p_size='unknown' and u.input_bytes is null))
 ), events as (
  select date_trunc(p_interval,uploaded_at) as bucket,'uploaded'::text as kind,upload_source='measured' as measured,null::float8 as hours,null::bigint as bytes
  from population where uploaded_at>=start_at and uploaded_at<=now()
  union all select date_trunc(p_interval,first_result_at),'result',result_source='measured',lead_hours,input_bytes
  from population where first_result_at>=start_at and first_result_at<=now()
  union all select date_trunc(p_interval,failed_at),case phase when 'first_result' then 'failed_first' else 'failed_other' end,start_source='measured',null,null
  from failures where failed_at>=start_at and failed_at<=now()
  union all select date_trunc(p_interval,recovered_at),'recovered',recovery_source='measured',recovery_hours,null
  from failures where recovered_at>=start_at and recovered_at<=now()
 ), totals as (
  select bucket,
   count(*) filter(where kind='uploaded') as uploaded,count(*) filter(where kind='uploaded' and measured) as uploaded_measured,
   count(*) filter(where kind='result') as first_ready,count(*) filter(where kind='result' and measured) as first_ready_measured,
   percentile_cont(0.5) within group(order by hours) filter(where kind='result') as lead_p50_hours,
   percentile_cont(0.9) within group(order by hours) filter(where kind='result') as lead_p90_hours,
   sum(bytes) filter(where kind='result')/1073741824.0 as completed_input_gib,count(bytes) filter(where kind='result') as volume_samples,
   count(*) filter(where kind='failed_first') as failures_first_result,count(*) filter(where kind='failed_other') as failures_other,
   count(*) filter(where kind in('failed_first','failed_other') and measured) as failures_measured,
   count(*) filter(where kind='recovered') as recovered,count(*) filter(where kind='recovered' and measured) as recovered_measured,
   percentile_cont(0.5) within group(order by hours) filter(where kind='recovered') as recovery_p50_hours,
   percentile_cont(0.9) within group(order by hours) filter(where kind='recovered') as recovery_p90_hours,
   count(hours) filter(where kind='recovered') as recovery_samples
  from events group by bucket
 ), series as (
  select b.start,b.start+step as "end",
   b.start+step>now() or (upload_since>b.start and upload_since<b.start+step) or (run_since>b.start and run_since<b.start+step) as partial,
   case when b.start+step>upload_since then coalesce(t.uploaded,0) end as uploaded,
   case when b.start+step>upload_since then coalesce(t.uploaded_measured,0) end as uploaded_measured,
   case when b.start+step>run_since then coalesce(t.first_ready,0) end as first_ready,
   case when b.start+step>run_since then coalesce(t.first_ready_measured,0) end as first_ready_measured,
   t.lead_p50_hours,t.lead_p90_hours,t.completed_input_gib,
   case when b.start+step>run_since then coalesce(t.volume_samples,0) end as volume_samples,
   case when b.start+step>run_since then coalesce(t.failures_first_result,0) end as failures_first_result,
   case when b.start+step>run_since then coalesce(t.failures_other,0) end as failures_other,
   case when b.start+step>run_since then coalesce(t.failures_measured,0) end as failures_measured,
   case when b.start+step>run_since then coalesce(t.recovered,0) end as recovered,
   case when b.start+step>run_since then coalesce(t.recovered_measured,0) end as recovered_measured,
   t.recovery_p50_hours,t.recovery_p90_hours,
   case when b.start+step>run_since then coalesce(t.recovery_samples,0) end as recovery_samples
  from generate_series(start_at,date_trunc(p_interval,now()),step) b(start) left join totals t on t.bucket=b.start
 ), waiting as (
  select * from population where first_result_at is null and not ready_now and not archived
 ), unresolved as (
  select * from failures where recovered_at is null and open_now and not archived
 )
 select jsonb_build_object('as_of',now(),'tracking_since',epoch,'failures_tracking_since',failures_epoch,
  'upload_since',upload_since,'run_since',run_since,'interval',p_interval,'workflow',p_workflow,'size',p_size,
  'summary',jsonb_build_object(
   'waiting',(select count(*) from waiting),
   'waiting_failed',(select count(*) from waiting where has_error),
   'waiting_contributors',(select count(distinct user_id) from waiting),
   'oldest_wait_hours',(select max(extract(epoch from(now()-uploaded_at))/3600.0) from waiting),
   'unresolved_failures',(select count(distinct dataset_id) from unresolved),
   'unresolved_first_result',(select count(distinct dataset_id) from unresolved where phase='first_result'),
   'oldest_unresolved_hours',(select max(extract(epoch from(now()-failed_at))/3600.0) from unresolved),
   'unrecorded_results',(select count(*) from population where first_result_at is null and ready_now)),
  'series',(select jsonb_agg(to_jsonb(series) order by start) from series),
  'coverage',jsonb_build_array(
   'Directly measured upload and first-result times start with registrations after measurement began; failures and recoveries are measured for every dataset from the failure tracking date. Everything earlier is reconstructed from retained upload and processor logs and labelled as such. Logs can be written by authenticated users, so reconstructed values are evidence, not protected measurement.',
   'A first complete result needs deadwood and forest-cover predictions (and a required area of interest). Reconstructed results are the first moment every readiness stage (ODM for ZIPs, ortho, metadata, COG, thumbnail, both predictions and a required area of interest) was proven by processor runs after upload; later search indexing is not part of the result. Uploads before the first retained processing run have no reconstructed result. Each dataset counts once; reruns and repeated notifications never add results.',
   'Time to first result runs from upload to that first result and includes queueing, every stage and any recovery. Uploads still without a result are shown as waiting, never inside the percentiles.',
   'A failure episode starts at a failed run (or a persisted error) and ends when the dataset is complete again: full readiness when measured; otherwise when a later run proved the failed stage again and every readiness stage is proven. A successful retry of other stages never ends an episode, and failures before that belong to the same episode. Episodes are split by whether the dataset was still waiting for its first result or had one already (reruns and search indexing). Without upload evidence or an earlier result the phase is unknown and grouped with reruns.',
   'Input GiB is the original uploaded size (measured or from the upload log), counted once when the dataset reaches its first result. Unknown sizes are left out and counted separately.',
   'Periods before the earliest retained upload or processor log are unknown, not zero. Deleted datasets and their logs are absent.'
  )) into result;
 return result;
end;
$$;

create or replace function public.factory_north_star(p_include_team boolean default false)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set jit=off as $$
declare result jsonb; run_since timestamptz; download_since timestamptz; week_start timestamptz; month_start timestamptz;
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 if p_include_team is null then raise exception 'Invalid Factory team filter' using errcode='22023'; end if;
 -- First results are observable from the first retained processor run (or measurement).
 select least(started_at,public.factory_run_evidence_since()) into run_since from public.factory_measurement_epoch;
 -- The API and database deploy separately, so the first recorded request, not the
 -- migration time, proves that recording is live; earlier weeks stay unknown.
 select min(requested_at) into download_since from public.dataset_download_requests where requested_at<=now();
 week_start:=date_trunc('week',now())-interval '12 weeks';
 month_start:=date_trunc('month',now())-interval '11 months';
 with team as materialized (
  select user_id from public.privileged_users where can_audit and not p_include_team
 ), uploads as materialized (
  select d.id as dataset_id,d.user_id,coalesce(h.uploaded_at,d.created_at) as uploaded_at,
   case when lower(d.file_name) like '%.zip' then 'odm' else 'geotiff' end as workflow
  from public.v2_datasets d
  left join public.v2_statuses s on s.dataset_id=d.id
  left join public.factory_historical_uploads h on h.dataset_id=d.id
  where (h.dataset_id is not null or s.is_upload_done) and d.created_at<=now()
   and not exists(select 1 from team t where t.user_id=d.user_id)
 ), results as materialized (
  -- Uploads before retained processor runs never count: their first result is unknown.
  select u.*,e.uploaded_at>=run_since as observable,
   case when e.uploaded_at>=run_since then e.first_result_at end as result_at
  from uploads u left join public.factory_outcome_evidence e on e.dataset_id=u.dataset_id
 ), timed as materialized (
  select *,extract(epoch from(result_at-uploaded_at))/3600.0 as hours from results
  where result_at is not null and result_at>=week_start
 ), timing as (
  select date_trunc('week',result_at) as start,count(*) as results,
   percentile_cont(0.5) within group(order by hours) filter(where workflow='geotiff') as geotiff_p50_hours,
   percentile_cont(0.9) within group(order by hours) filter(where workflow='geotiff') as geotiff_p90_hours,
   count(*) filter(where workflow='geotiff') as geotiff_samples,
   percentile_cont(0.5) within group(order by hours) filter(where workflow='odm') as odm_p50_hours,
   percentile_cont(0.9) within group(order by hours) filter(where workflow='odm') as odm_p90_hours,
   count(*) filter(where workflow='odm') as odm_samples
  from timed group by 1
 ), audits as materialized (
  select a.audit_date as audited_at from public.dataset_audit a join public.v2_datasets d on d.id=a.dataset_id
  where a.final_assessment in ('no_issues','ready') and a.audit_date>=week_start and a.audit_date<=now()
   and not exists(select 1 from team t where t.user_id=d.user_id)
 ), published as materialized (
  select j.dataset_id,min(p.published_at) as published_at
  from public.data_publication p
  join public.jt_data_publication_datasets j on j.publication_id=p.id
  join public.v2_datasets d on d.id=j.dataset_id
  where p.status='published' and p.published_at<=now()
   and not exists(select 1 from team t where t.user_id=d.user_id)
  group by j.dataset_id
 ), downloads as materialized (
  -- One entry per accepted request; a bundle is reuse if any dataset is someone else's.
  select r.request_id,min(r.requested_at) as requested_at,bool_or(r.user_id is distinct from d.user_id) as reuse
  from public.dataset_download_requests r join public.v2_datasets d on d.id=r.dataset_id
  where r.requested_at>=week_start and r.requested_at<=now()
   and not exists(select 1 from team t where t.user_id=r.user_id)
  group by r.request_id
 ), signups as materialized (
  select u.id as user_id,u.created_at from auth.users u
  where u.created_at<=now() and not exists(select 1 from team t where t.user_id=u.id)
 ), first_uploads as materialized (
  select user_id,min(uploaded_at) as first_at from uploads where user_id is not null group by user_id
 ), weeks as (
  select t as start,t+interval '1 week' as finish from generate_series(week_start,date_trunc('week',now()),interval '1 week') t
 ), weekly as (
  select w.start,w.finish as "end",w.finish>now() as partial,
   (select count(*) from signups s where s.created_at>=w.start and s.created_at<w.finish) as signups,
   (select count(*) from first_uploads f where f.first_at>=w.start and f.first_at<w.finish) as first_uploaders,
   (select count(*) from uploads u where u.uploaded_at>=w.start and u.uploaded_at<w.finish) as uploads,
   case when w.start>=run_since then coalesce(t.results,0) end as results,
   -- Grouped by upload week; a week enters once all its uploads had 7 days.
   case when w.start>=run_since and w.finish<=now()-interval '7 days' then
    (select count(*) from results r where r.observable and r.uploaded_at>=w.start and r.uploaded_at<w.finish) end as reach_eligible,
   case when w.start>=run_since and w.finish<=now()-interval '7 days' then
    (select count(*) from results r where r.observable and r.uploaded_at>=w.start and r.uploaded_at<w.finish
     and (r.result_at is null or r.result_at>r.uploaded_at+interval '7 days')) end as not_reached_7d,
   t.geotiff_p50_hours,t.geotiff_p90_hours,coalesce(t.geotiff_samples,0) as geotiff_samples,
   t.odm_p50_hours,t.odm_p90_hours,coalesce(t.odm_samples,0) as odm_samples,
   (select count(*) from audits a where a.audited_at>=w.start and a.audited_at<w.finish) as audited_usable,
   (select count(*) from published p where p.published_at>=w.start and p.published_at<w.finish) as published,
   case when w.finish>download_since then (select count(*) from downloads x where x.requested_at>=w.start and x.requested_at<w.finish) end as downloads,
   case when w.finish>download_since then (select count(*) from downloads x where x.reuse and x.requested_at>=w.start and x.requested_at<w.finish) end as reuse_downloads
  from weeks w left join timing t on t.start=w.start
 ), months as (
  select t as start,t+interval '1 month' as finish from generate_series(month_start,date_trunc('month',now()),interval '1 month') t
 ), cohorts as (
  -- Activation: a signup uploads within 30 days. Retention: a first-time
  -- contributor uploads again on a later day within 90 days. Only elapsed
  -- windows enter denominators, so recent months stay unknown.
  select m.start,m.finish as "end",
   (select count(*) from signups s where s.created_at>=m.start and s.created_at<m.finish) as signups,
   (select count(*) from signups s where s.created_at>=m.start and s.created_at<m.finish and s.created_at<=now()-interval '30 days') as activation_eligible,
   (select count(*) from signups s join first_uploads f on f.user_id=s.user_id
    where s.created_at>=m.start and s.created_at<m.finish and s.created_at<=now()-interval '30 days'
     and f.first_at<=s.created_at+interval '30 days') as activated_30d,
   (select count(*) from first_uploads f where f.first_at>=m.start and f.first_at<m.finish) as new_contributors,
   (select count(*) from first_uploads f where f.first_at>=m.start and f.first_at<m.finish and f.first_at<=now()-interval '90 days') as retention_eligible,
   (select count(*) from first_uploads f where f.first_at>=m.start and f.first_at<m.finish and f.first_at<=now()-interval '90 days'
    and exists(select 1 from uploads u where u.user_id=f.user_id
     and u.uploaded_at>=f.first_at+interval '1 day' and u.uploaded_at<=f.first_at+interval '90 days')) as returned_90d
  from months m
 ), stalled as (
  -- Where uploads that missed the 7-day window stand now, by the first
  -- required stage that is still incomplete (pipeline order).
  select case
    when r.result_at is not null then 'late'
    when not coalesce(s.is_upload_done,false) then 'upload'
    when r.workflow='odm' and not coalesce(s.is_odm_done,false) then 'odm'
    when not coalesce(s.is_ortho_done,false) then 'ortho'
    when not coalesce(s.is_cog_done,false) then 'cog'
    when not coalesce(s.is_thumbnail_done,false) then 'thumbnail'
    when not coalesce(s.is_metadata_done,false) then 'metadata'
    when not (coalesce(s.is_combined_model_done,false) or (coalesce(s.is_deadwood_done,false) and coalesce(s.is_forest_cover_done,false))) then 'segmentation'
    when coalesce(s.is_aoi_required,false) and not coalesce(s.is_aoi_done,false) then 'aoi'
    else 'unrecorded' end as step,
   coalesce(s.has_error,false) as has_error
  from results r left join public.v2_statuses s on s.dataset_id=r.dataset_id
  where r.observable and r.uploaded_at>=greatest(week_start,run_since) and r.uploaded_at<=now()-interval '7 days'
   and (r.result_at is null or r.result_at>r.uploaded_at+interval '7 days')
 )
 select jsonb_build_object('as_of',now(),'include_team',p_include_team,
  'team_accounts',(select count(*) from public.privileged_users where can_audit),
  'run_since',run_since,'download_since',download_since,
  'weekly',coalesce((select jsonb_agg(to_jsonb(weekly) order by start) from weekly),'[]'::jsonb),
  'cohorts',coalesce((select jsonb_agg(to_jsonb(cohorts) order by start) from cohorts),'[]'::jsonb),
  'stalled',coalesce((select jsonb_agg(jsonb_build_object('step',step,'datasets',datasets,'with_error',with_error) order by datasets desc,step)
   from (select step,count(*) as datasets,count(*) filter(where has_error) as with_error from stalled group by step) g),'[]'::jsonb),
  'coverage',jsonb_build_array(
   'Team means accounts with auditor privileges. Excluding the team removes their signups, their uploads and the audits and publications of datasets they own, and their download requests.',
   'Complete results count each dataset once, at its first complete result: measured readiness where available, otherwise the first moment processor runs after upload had proven every readiness stage, reconstructed from retained processor logs. Uploads before the first retained processing run are never counted, because their first result is unknown.',
   'Upload times come from direct measurement or upload logs; older datasets fall back to their registration time.',
   'Never reached within 7 days groups uploads by upload week and includes late results. The stage breakdown shows where those uploads stand now, not where they first failed.',
   'Reference data counts audits whose final assessment is no issues. Fixable and excluded datasets are not counted. Audits count by audit date.',
   'Downloads are accepted download requests, not completed transfers. Reuse means someone other than the dataset owner. Coverage starts with the first request the API recorded; earlier weeks are unknown, and that first week is a lower bound. Older request logs were written before access checks and are not used.',
   'Activation and retention use monthly cohorts and only count elapsed windows. A return upload must be on a later day, so one batch is one visit. Deleted datasets and accounts are absent.'
  )) into result;
 return result;
end;
$$;

-- Upload-to-first-result timing now lives with the outcome charts; history keeps activity counts.
create or replace function public.factory_history(p_year integer default null)
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
 bounds as (select (select min(uploaded_at) from uploads) as upload_since,(select min(happened_at) from runs) as run_since,
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
   case when b.finish>upload_since then coalesce(v.returning_contributors,0) end as returning_contributors
  from buckets b cross join bounds left join totals t on t.bucket=b.start left join volume v on v.bucket=b.start
 )
 select jsonb_build_object('as_of',now(),'first_registration',first_at,'year',p_year,
  'years',(select jsonb_agg(y order by y desc) from generate_series(extract(year from coalesce(first_at,now()))::integer,extract(year from now())::integer) y),
  'upload_since',(select upload_since from bounds),'run_since',(select run_since from bounds),
  'report_since',(select report_since from bounds),'publication_since',(select publication_since from bounds),'email_since',(select email_since from bounds),
  'coverage',jsonb_build_object('datasets',(select count(*) from public.v2_datasets),
   'upload_evidence',(select count(*) from uploads),'upload_sizes',(select count(input_bytes) from uploads),
   'measured_uploads',(select count(*) from uploads where source='measured'),
   'ready_now',(select count(*) from public.v2_datasets d join public.v2_statuses s on s.dataset_id=d.id where not d.archived and public.factory_status_ready(s,d.file_name))),
  'series',coalesce((select jsonb_agg(to_jsonb(series) order by start) from series),'[]'::jsonb)) into result;
 return result;
end;
$$;

-- Detail pages show the same first-result and failure evidence as the charts.
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
      || coalesce((select jsonb_build_object('first_result_at',e.first_result_at,'first_result_source',e.result_source)
        from public.factory_outcome_evidence e where e.dataset_id=p_dataset_id),'{}'::jsonb)
      from public.v2_statuses s left join public.factory_submissions m on m.dataset_id=s.dataset_id where s.dataset_id=p_dataset_id),
    'failures',coalesce((select jsonb_agg(to_jsonb(f) order by f.failed_at desc nulls last) from (
      select failed_at,recovered_at,start_source,recovery_source,phase from public.factory_failure_evidence
      where dataset_id=p_dataset_id order by failed_at desc nulls last limit 200) f),'[]'::jsonb),
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

notify pgrst,'reload schema';
commit;
