-- Factory outcome reads timed out in production (factory_north_star exceeded the
-- 8 s statement timeout at 1.8 million v2_logs rows).
-- 1. The retained-run boundary was a bare STABLE function call in a LEFT JOIN
--    condition, evaluated once per dataset (about 33 ms each in production). A
--    scalar subquery evaluates it once per query.
-- 2. The failure evidence derived processor runs three times. One timeline view now
--    derives proofs, resets, failures and ready moments in a single pass.
-- Semantics are unchanged.
begin;
-- One pass over processor-run evidence for everything derived from it, so each
-- evidence view reads the run logs once instead of two or three times:
-- 'proof'   a requested stage proven done: the first success at or past it in its
--           run (stages run in order; a failing stage ends the run);
-- 'reset'   a run following a failed run resets its requested stages at its start
--           (requeueing a failed dataset clears their done flags);
-- 'aoi_required' a run requesting an area of interest makes it a lasting requirement;
-- 'failed'  a failed or crashed run, with the failed stage's position;
-- 'ready'   a moment of full readiness as factory_status_ready defines it (ODM for
--           ZIPs, ortho, metadata, COG, thumbnail, deadwood and forest cover, and a
--           required area of interest), checked at each proof time against the
--           proofs not yet reset.
create view public.factory_stage_timeline with(security_invoker=true) as
 with events as materialized (
  select dataset_id,id,run,created_at,kind,position,
   first_value(requested) over run_order as run_requested,
   first_value(created_at) over run_order as run_started_at,
   max(position) filter(where kind='success') over(run_order rows between unbounded preceding and 1 preceding) as reached,
   bool_or(kind='failed') over(partition by dataset_id,run) as run_failed
  from public.factory_run_log_events
  window run_order as(partition by dataset_id,run order by created_at,id)
 ), starts as (
  select dataset_id,run_started_at,run_requested,
   coalesce(lag(run_failed) over(partition by dataset_id order by run),false) as after_failure
  from events where kind='start' and run>0
 ), evidence as materialized (
  select e.dataset_id,e.run_started_at,p.position,e.created_at as at,'proof'::text as event
  from events e cross join lateral generate_series(coalesce(e.reached,0)+1,e.position) p(position)
  where e.run>0 and e.kind='success' and e.position>coalesce(e.reached,0) and p.position=any(e.run_requested)
  union all
  select dataset_id,run_started_at,p.position,run_started_at,'reset'
  from starts cross join lateral unnest(run_requested) p(position) where after_failure and p.position is not null
  union all
  select dataset_id,run_started_at,9,run_started_at,'aoi_required' from starts where 9=any(run_requested)
 ), valid as (
  select dataset_id,position,at as valid_from,valid_to from (
   select dataset_id,position,event,at,
    -- A reset happens at its run's start, before that run's own proofs.
    min(at) filter(where event='reset') over(partition by dataset_id,position order by at,event='proof'
     rows between 1 following and unbounded following) as valid_to
   from evidence where event in('proof','reset')) x
  where event='proof'
 ), candidates as (
  select distinct dataset_id,at from evidence where event='proof'
 ), coverage as materialized (
  select c.dataset_id,c.at,
   bool_or(v.position=1) as odm,bool_or(v.position=2) as ortho,bool_or(v.position=3) as metadata,
   bool_or(v.position=4) as cog,bool_or(v.position=5) as thumbnail,bool_or(v.position=6) as deadwood,
   bool_or(v.position=7) as forest_cover,bool_or(v.position=8) as combined,bool_or(v.position=9) as aoi
  from candidates c join valid v on v.dataset_id=c.dataset_id and v.valid_from<=c.at and (v.valid_to is null or c.at<v.valid_to)
  group by c.dataset_id,c.at
 ), aoi as (
  select dataset_id,min(at) as required_since from evidence where event='aoi_required' group by dataset_id
 ), readiness as materialized (
  -- One computed flag, filtered after materialization: planning the nine
  -- requirement conditions separately underestimated ready rows by orders of
  -- magnitude and led callers into nested-loop rescans.
  select c.dataset_id,c.at,
   (lower(d.file_name) not like '%.zip' or c.odm) and c.ortho and c.metadata and c.cog and c.thumbnail
    and (c.combined or (c.deadwood and c.forest_cover))
    and (a.required_since is null or a.required_since>c.at or c.aoi) as ready
  from coverage c join public.v2_datasets d on d.id=c.dataset_id left join aoi a on a.dataset_id=c.dataset_id
 )
 select dataset_id,run_started_at,position,at,event,null::bigint as log_id from evidence
 union all
 select dataset_id,null,null,at,'ready',null from readiness where ready
 union all
 select dataset_id,run_started_at,position,created_at,'failed',id from events where kind='failed';
revoke all on public.factory_stage_timeline from public,anon,authenticated;

create or replace view public.factory_outcome_evidence with(security_invoker=true) as
 with firsts as (
  -- First ready moment at or after the upload, by aggregating uploads and ready
  -- moments together per dataset: a join of the two sets was planned as a
  -- nested loop over thousands of rows per dataset at production scale.
  select dataset_id,min(at) filter(where event='ready' and after_upload) as first_result_at
  from (select dataset_id,at,event,
    bool_or(event='upload') over(partition by dataset_id order by at,event='ready' rows unbounded preceding) as after_upload
   from (select dataset_id,uploaded_at as at,'upload'::text as event from public.factory_historical_uploads
    union all select dataset_id,at,event from public.factory_stage_timeline where event='ready') x) y
  group by dataset_id
 )
 select u.dataset_id,u.user_id,u.uploaded_at,u.source as upload_source,u.input_bytes,
  case when lower(d.file_name) like '%.zip' then 'odm' else 'geotiff' end as workflow,
  case when m.dataset_id is not null then m.first_ready_at else r.first_result_at end as first_result_at,
  case when m.dataset_id is not null then case when m.first_ready_at is not null then 'measured' end
   when r.first_result_at is not null then 'processing_log' end as result_source
 from public.factory_historical_uploads u
 join public.v2_datasets d on d.id=u.dataset_id
 left join public.factory_submissions m on m.dataset_id=u.dataset_id
 left join firsts r on r.dataset_id=u.dataset_id and u.uploaded_at>=(select public.factory_run_evidence_since());


create or replace view public.factory_failure_evidence with(security_invoker=true) as
 with epoch as (select failures_started_at as observed_from from public.factory_measurement_epoch),
 timeline as materialized (select * from public.factory_stage_timeline),
 ready as (
  select dataset_id,min(at) as first_ready_at from timeline where event='ready' group by dataset_id
 ), failures as (
  select dataset_id,log_id as id,at as failed_at,position as failed_position,
   lead(at) over(partition by dataset_id order by at,log_id) as next_failed_at
  from timeline where event='failed'
 ), reproofs as (
  select f.dataset_id,f.id,min(p.at) as reproved_at
  from failures f join timeline p on p.dataset_id=f.dataset_id and p.event='proof'
   and p.position=f.failed_position and p.run_started_at>f.failed_at
  group by f.dataset_id,f.id
 ), complete_again as (
  -- A run started after the failure proved the failed stage, and full readiness
  -- held then or later, before any further failure.
  select rp.dataset_id,rp.id,min(m.at) as recovered_at
  from reproofs rp join failures f on f.dataset_id=rp.dataset_id and f.id=rp.id
  join timeline m on m.dataset_id=rp.dataset_id and m.event='ready' and m.at>=rp.reproved_at
   and (f.next_failed_at is null or m.at<f.next_failed_at)
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
drop view public.factory_ready_moments;
drop view public.factory_stage_proofs;

notify pgrst,'reload schema';
commit;
