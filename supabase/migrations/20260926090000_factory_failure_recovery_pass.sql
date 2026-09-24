-- factory_trends still timed out in production (PG 57014) after 20260925100000.
-- Recovery matched each failure to later proofs and ready moments with range
-- joins; the planner estimated a handful of timeline rows instead of ~10^5 and
-- chose nested loops that rescanned every ready moment per reproved failure (13 s
-- of 14 s at production shape). Each failure now owns the timeline rows up to the
-- next failure in one ordered pass, so recovery needs no join at all. Results are
-- unchanged: a proof or ready moment only counts before the next failure anyway.
begin;

create or replace view public.factory_failure_evidence with(security_invoker=true) as
 with epoch as (select failures_started_at as observed_from from public.factory_measurement_epoch),
 timeline as materialized (select * from public.factory_stage_timeline),
 ready as (
  select dataset_id,min(at) as first_ready_at from timeline where event='ready' group by dataset_id
 ), sequence as (
  -- Each failure owns the evidence from it until the next failure, which sorts
  -- first at equal times: exactly the window in which it can be resolved.
  select *,count(*) filter(where event='failed') over(partition by dataset_id order by at,event<>'failed',log_id rows unbounded preceding) as failure_no
  from timeline where event in('failed','proof','ready')
 ), owned as (
  select *,max(at) filter(where event='failed') over failure as failed_at,
   max(position) filter(where event='failed') over failure as failed_position,
   max(log_id) filter(where event='failed') over failure as failure_id
  from sequence where failure_no>0 window failure as(partition by dataset_id,failure_no)
 ), reproved as (
  -- A run started after the failure proved the failed stage ...
  select *,min(at) filter(where event='proof' and position=failed_position and run_started_at>failed_at)
   over(partition by dataset_id,failure_no) as reproved_at
  from owned
 ), recovered as (
  -- ... and full readiness held then or later, before any further failure.
  select dataset_id,failure_id as id,failed_at,min(at) filter(where event='ready' and at>=reproved_at) as recovered_at
  from reproved group by dataset_id,failure_no,failure_id,failed_at
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

notify pgrst,'reload schema';
commit;
