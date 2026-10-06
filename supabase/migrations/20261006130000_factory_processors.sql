-- Processor health for the Factory Operations tab, from the database only.
-- One row per processor host: what it holds now, its last database signal, and
-- how many tasks it started, finished and failed in the last 24 hours.
-- Per-host history comes from processor log rows tagged with extra.worker_id and
-- extra.event (task_started, task_completed, task_failed). GPU, disk and memory
-- live only on the hosts; processor_heartbeats can carry them later.
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

-- v2_processor_claims (20261006100000) reads host names from processor_hosts
-- instead of its own list, so a new host is added in one place.
CREATE OR REPLACE VIEW public.v2_processor_claims
WITH (security_invoker = true) AS
SELECT
    coalesce(host.name, q.claimed_by) AS processor,
    q.dataset_id,
    d.file_name AS dataset,
    s.current_status AS stage,
    s.has_error,
    date_trunc('second', now() - q.claimed_at) AS running_for,
    q.claimed_at,
    date_trunc('second', q.claimed_at - q.created_at) AS waited_in_queue,
    q.created_at AS queued_at,
    q.priority,
    q.task_types,
    round(s.uploaded_input_bytes / 1048576.0) AS input_size_mb,
    last_log.created_at AS last_log_at,
    last_log.message AS last_log,
    last_log.backend_version,
    q.claimed_by AS worker_id,
    q.id AS queue_id,
    q.user_id
FROM public.v2_queue q
LEFT JOIN public.processor_hosts AS host ON host.worker_id = q.claimed_by
LEFT JOIN public.v2_datasets d ON d.id = q.dataset_id
LEFT JOIN public.v2_statuses s ON s.dataset_id = q.dataset_id
LEFT JOIN LATERAL (
    SELECT l.created_at, left(l.message, 300) AS message, l.backend_version
    FROM public.v2_logs l
    WHERE l.dataset_id = q.dataset_id
      AND l.created_at >= q.claimed_at
    ORDER BY l.created_at DESC
    LIMIT 1
) AS last_log ON true
WHERE q.claimed_by IS NOT NULL
ORDER BY q.claimed_at;

-- Each processor upserts its row about once a minute while it polls, so an
-- idle host is told apart from an offline one.
create table public.processor_heartbeats (
  worker_id text primary key,
  seen_at timestamptz not null,
  backend_version text
);
comment on table public.processor_heartbeats is 'Latest poll of each processor worker; written by the processor about once a minute.';
alter table public.processor_heartbeats enable row level security;
revoke all on public.processor_heartbeats from public,anon,authenticated;
grant select,insert,update on public.processor_heartbeats to authenticated;
create policy "Processor writes its heartbeat" on public.processor_heartbeats
  for all to authenticated
  using ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
  with check ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text);
grant select on public.processor_heartbeats to analyst;
create policy analyst_select on public.processor_heartbeats for select to analyst using (true);

create function public.factory_processors() returns jsonb
language plpgsql stable security definer set search_path='' set jit=off as $$
declare result jsonb;
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 with events as (
  -- One day of host-tagged rows; dataset_id keeps the read on v2_logs_factory_activity_idx.
  select l.extra->>'worker_id' as worker_id,l.extra->>'event' as event,l.dataset_id,l.created_at,l.extra->>'stage' as stage
  from public.v2_logs l
  where l.created_at>now()-interval '24 hours' and l.dataset_id is not null and l.extra ? 'worker_id'
 ), activity as (
  select worker_id,max(created_at) as last_log_at,
   count(*) filter(where event='task_started') as started_24h,
   count(*) filter(where event='task_completed') as completed_24h,
   count(*) filter(where event='task_failed') as failed_24h,
   (array_agg(jsonb_build_object('dataset_id',dataset_id,'at',created_at,'stage',stage) order by created_at desc)
    filter(where event='task_failed'))[1] as last_failure
  from events group by worker_id
 ), claims as (
  -- The same claim and last-signal definitions as the attention list.
  select worker_id,
   jsonb_agg(jsonb_build_object('dataset_id',dataset_id,'file_name',file_name,'stage',stage,
    'task_types',task_types,'claimed_at',claimed_at,'last_signal_at',last_signal_at) order by claimed_at) as claims,
   max(last_signal_at) as last_signal_at
  from public.factory_dataset_records where state='claimed' and worker_id is not null
  group by worker_id
 ), rows as (
  select w.worker_id,coalesce(h.name,w.worker_id) as name,c.claims,c.last_signal_at as claim_signal_at,
   b.seen_at as heartbeat_at,b.backend_version,a.last_log_at,a.started_24h,a.completed_24h,a.failed_24h,a.last_failure
  from (select worker_id from public.processor_hosts union select worker_id from claims union select worker_id from activity
   union select worker_id from public.processor_heartbeats where seen_at>now()-interval '7 days') w
  left join public.processor_hosts h on h.worker_id=w.worker_id
  left join public.processor_heartbeats b on b.worker_id=w.worker_id
  left join claims c on c.worker_id=w.worker_id
  left join activity a on a.worker_id=w.worker_id
 )
 select jsonb_build_object('as_of',now(),
  'processors',coalesce((select jsonb_agg(jsonb_build_object(
   'worker_id',worker_id,'name',name,
   'state',case when claims is not null and claim_signal_at>=now()-interval '1 hour' then 'working'
    when claims is not null then 'silent'
    when heartbeat_at>=now()-interval '10 minutes' then 'idle'
    else 'unknown' end,
   'claims',coalesce(claims,'[]'::jsonb),'last_signal_at',coalesce(claim_signal_at,greatest(heartbeat_at,last_log_at)),
   'heartbeat_at',heartbeat_at,'backend_version',backend_version,
   'started_24h',coalesce(started_24h,0),'completed_24h',coalesce(completed_24h,0),'failed_24h',coalesce(failed_24h,0),
   'last_failure',last_failure)
   order by name) from rows),'[]'::jsonb),
  'coverage',jsonb_build_array(
   'Working means a held claim with a database signal in the last hour; silent means a held claim without one. A long stage can look silent; it does not prove a stuck worker.',
   'Idle means no claim and a heartbeat in the last 10 minutes; processors send one about once a minute while they poll. Unknown means neither: the host is offline, stuck outside a task, or runs a release from before heartbeats.',
   'Started, finished and failed counts and the last failure cover the last 24 hours of processor log rows tagged with the host; a log row that failed to write is missing from them. A crash found when a task is claimed counts against the host that found it, which may not be the host that crashed. GPU, disk and memory state live on the hosts and are not shown.'
  )) into result;
 return result;
end;
$$;
revoke all on function public.factory_processors() from public,anon;
grant execute on function public.factory_processors() to authenticated;

notify pgrst,'reload schema';
commit;
