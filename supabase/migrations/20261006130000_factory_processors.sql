-- Processor health for the Factory Operations tab, from the database only.
-- One row per processor host: what it holds now, when it last wrote a log, and
-- how many tasks it started, finished and failed in the last 24 hours.
-- Per-host history comes from processor log rows tagged with extra.worker_id and
-- extra.event (task_started, task_completed, task_failed). GPU, disk and memory
-- live only on the hosts; a heartbeat table can join this function later.
begin;
set local lock_timeout = '5s';

-- Known processor hosts by worker ID (docs/playbooks/processor-hosts.md). A
-- worker missing here still appears, under its raw ID.
create table public.processor_hosts (
  worker_id text primary key,
  name text not null unique
);
insert into public.processor_hosts(worker_id,name) values
 ('host-f9760a054cb8','processing-server'),
 ('host-bb400fd18e59','helicon'),
 ('host-56916e6e7ab8','deepl1');
comment on table public.processor_hosts is
 'Readable names for processor worker IDs (v2_queue.claimed_by, v2_logs.extra.worker_id).';
alter table public.processor_hosts enable row level security;
revoke all on public.processor_hosts from public,anon,authenticated;
grant select on public.processor_hosts to analyst;
create policy analyst_select on public.processor_hosts for select to analyst using (true);

create function public.factory_processors() returns jsonb
language plpgsql stable security definer set search_path='' set jit=off as $$
declare result jsonb;
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 with events as materialized (
  select l.extra->>'worker_id' as worker_id,l.extra->>'event' as event,l.dataset_id,l.created_at,l.extra->>'stage' as stage
  from public.v2_logs l
  -- dataset_id keeps the read on v2_logs_factory_activity_idx; lifecycle rows carry it.
  where l.created_at>now()-interval '7 days' and l.dataset_id is not null and l.extra ? 'worker_id'
 ), claims as (
  select q.claimed_by as worker_id,q.dataset_id,q.claimed_at,q.task_types,d.file_name,s.current_status::text as stage,
   greatest(q.claimed_at,s.updated_at,(select max(l.created_at) from public.v2_logs l
    where l.dataset_id=q.dataset_id and l.created_at>=q.claimed_at)) as last_signal_at
  from public.v2_queue q
  left join public.v2_datasets d on d.id=q.dataset_id
  left join public.v2_statuses s on s.dataset_id=q.dataset_id
  where q.is_processing and q.claimed_by is not null
 ), workers as (
  select worker_id from public.processor_hosts
  union select worker_id from claims
  union select worker_id from events
 ), rows as (
  select w.worker_id,coalesce(h.name,w.worker_id) as name,
   (select jsonb_agg(jsonb_build_object('dataset_id',c.dataset_id,'file_name',c.file_name,'stage',c.stage,
     'task_types',c.task_types,'claimed_at',c.claimed_at,'last_signal_at',c.last_signal_at) order by c.claimed_at)
    from claims c where c.worker_id=w.worker_id) as claims,
   (select max(c.last_signal_at) from claims c where c.worker_id=w.worker_id) as claim_signal_at,
   (select max(e.created_at) from events e where e.worker_id=w.worker_id) as last_log_at,
   (select count(*) from events e where e.worker_id=w.worker_id and e.event='task_started' and e.created_at>now()-interval '24 hours') as started_24h,
   (select count(*) from events e where e.worker_id=w.worker_id and e.event='task_completed' and e.created_at>now()-interval '24 hours') as completed_24h,
   (select count(*) from events e where e.worker_id=w.worker_id and e.event='task_failed' and e.created_at>now()-interval '24 hours') as failed_24h,
   (select jsonb_build_object('dataset_id',e.dataset_id,'at',e.created_at,'stage',e.stage)
    from events e where e.worker_id=w.worker_id and e.event='task_failed' order by e.created_at desc limit 1) as last_failure
  from workers w left join public.processor_hosts h on h.worker_id=w.worker_id
 )
 select jsonb_build_object('as_of',now(),
  'processors',coalesce((select jsonb_agg(jsonb_build_object(
   'worker_id',worker_id,'name',name,
   'state',case when claims is not null and claim_signal_at>=now()-interval '1 hour' then 'working'
    when claims is not null then 'silent'
    when last_log_at>=now()-interval '24 hours' then 'idle'
    else 'unknown' end,
   'claims',coalesce(claims,'[]'::jsonb),'last_log_at',last_log_at,
   'started_24h',started_24h,'completed_24h',completed_24h,'failed_24h',failed_24h,'last_failure',last_failure)
   order by name) from rows),'[]'::jsonb),
  'coverage',jsonb_build_array(
   'Working means a held claim with a database signal in the last hour; silent means a held claim without one. A long stage can look silent; it does not prove a stuck worker.',
   'Idle means no claim but a log line from this host in the last 24 hours. Unknown means neither: the host may be offline, or it runs a release from before hosts tagged their logs.',
   'Started, finished and failed counts and the last failure come from processor log rows tagged with the host, kept for 7 days here. GPU, disk and memory state live on the hosts and are not shown.'
  )) into result;
 return result;
end;
$$;
revoke all on function public.factory_processors() from public,anon;
grant execute on function public.factory_processors() to authenticated;

notify pgrst,'reload schema';
commit;
