-- Factory is an explicit operational-metadata capability, not an audit or
-- imagery-access capability. Existing users are not automatically promoted.
begin;

alter table public.privileged_users add column can_operate boolean not null default false;

create function public.can_operate() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.privileged_users
    where user_id = auth.uid() and can_operate);
$$;
revoke all on function public.can_operate() from public, anon;
grant execute on function public.can_operate() to authenticated;

-- These lookups cover the complete dataset population, including old jobs.
create index v2_queue_dataset_factory_idx on public.v2_queue (dataset_id);
create index user_info_user_factory_idx on public.user_info ("user",id);
create index publication_dataset_factory_idx on public.jt_data_publication_datasets (dataset_id,publication_id);

create function public.factory_status_ready(s public.v2_statuses, file_name text)
returns boolean language sql immutable set search_path='' as $$
 select coalesce(not s.has_error and s.current_status='idle' and s.is_upload_done
 and (lower(file_name) not like '%.zip' or s.is_odm_done)
 and s.is_ortho_done and s.is_metadata_done and s.is_cog_done and s.is_thumbnail_done
 and (s.is_combined_model_done or (s.is_deadwood_done and s.is_forest_cover_done))
 and (not s.is_aoi_required or s.is_aoi_done),false);
$$;
revoke all on function public.factory_status_ready(public.v2_statuses,text) from public,anon,authenticated;

-- Not exposed as a PostgREST relation. Only the gated read functions below
-- may use this canonical population; no underlying RLS policy is broadened.
create view public.factory_dataset_records with (security_invoker = true) as
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
  greatest(s.updated_at, log.created_at, q.claimed_at) as last_signal_at,
  ready.value as is_ready, coalesce(s.is_upload_done,false) as upload_done,
  coalesce(n.status,'none') as notification_state,
  exists (select 1 from public.processing_notification_events e where e.dataset_id=d.id
    and (e.status='failed' or (e.status in ('pending','sending') and e.next_attempt_at < now()))) as notification_problem,
  coalesce(pub.status,'none') as publication_state,
  (select count(*) from public.dataset_flags f where f.dataset_id=d.id and f.status <> 'resolved') as open_reports,
  exists (select 1 from public.dataset_audit a where a.dataset_id=d.id) as has_audit,
  'unknown'::text as intent
from public.v2_datasets d
left join auth.users u on u.id=d.user_id
left join lateral (select organisation from public.user_info where "user"=d.user_id order by id limit 1) ui on true
left join public.v2_statuses s on s.dataset_id=d.id
left join lateral (select id,is_processing,claimed_by,claimed_at,created_at,priority,task_types
  from public.v2_queue where dataset_id=d.id
  order by is_processing desc,priority desc,created_at,id limit 1) q on true
left join lateral (select created_at from public.v2_logs where dataset_id=d.id order by created_at desc limit 1) log on true
left join lateral (select status from public.processing_notification_events where dataset_id=d.id
  order by created_at desc,id desc limit 1) n on true
left join lateral (select p.status::text from public.data_publication p
  join public.jt_data_publication_datasets j on j.publication_id=p.id
  where j.dataset_id=d.id order by p.created_at desc,p.id desc limit 1) pub on true
cross join lateral (select public.factory_status_ready(s,d.file_name) as value) ready;
revoke all on public.factory_dataset_records from public, anon, authenticated;

-- One filter definition for table totals, rows and selected-record handoffs.
create function public.factory_filtered_datasets(p_filters jsonb)
returns setof public.factory_dataset_records
language sql stable set search_path = '' as $$
  select r.* from public.factory_dataset_records r
  where (coalesce(p_filters->>'archived','no')='all'
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
revoke all on function public.factory_filtered_datasets(jsonb) from public, anon, authenticated;

create function public.factory_datasets(p_filters jsonb default '{}',p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
  if p_filters is null or jsonb_typeof(p_filters)<>'object' or p_limit is null or p_limit<1 or p_limit>500
    or p_offset is null or p_offset<0 then raise exception 'Invalid Factory pagination or filters' using errcode='22023'; end if;
  with filtered as materialized (select * from public.factory_filtered_datasets(p_filters)),
  page as (select * from filtered order by dataset_id desc limit p_limit offset p_offset)
  select jsonb_build_object('as_of',now(),'total',(select count(*) from filtered),
    'items',coalesce((select jsonb_agg(to_jsonb(page) order by dataset_id desc) from page),'[]'::jsonb)) into result;
  return result;
end;
$$;

create function public.factory_overview(p_days integer default 7)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb; since_at timestamptz;
begin
  if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
  if p_days is null or p_days<1 or p_days>365 then raise exception 'Invalid Factory period' using errcode='22023'; end if;
  since_at := now()-make_interval(days=>p_days);
  with population as materialized (select * from public.factory_dataset_records where not archived),
  counts as (select jsonb_build_object(
    'datasets',count(*),'ready',count(*) filter(where is_ready),
    'queued',count(*) filter(where state='queued'),'claimed',count(*) filter(where state='claimed'),
    'failed',count(*) filter(where state='failed'),'uncertain',count(*) filter(where state='uncertain'),
    'contributors_needing_attention',count(distinct user_id) filter(where has_error or notification_problem or open_reports>0 or state='uncertain'),
    'new_submissions',count(*) filter(where created_at>=since_at and upload_done),
    'new_contributors',count(distinct user_id) filter(where created_at>=since_at and upload_done),
    'notification_problems',count(*) filter(where notification_problem),
    'publication_pending',count(*) filter(where publication_state in ('pending','uploading','in_review','error')),
    'open_reports',count(*) filter(where open_reports>0),
    'audits_in_period',(select count(*) from public.dataset_audit a join population r on r.dataset_id=a.dataset_id where a.reviewed_at>=since_at),
    'validated_patches',(select count(*) from public.reference_patches p join population r on r.dataset_id=p.dataset_id where p.deadwood_validated and p.forest_cover_validated),
    'publications_in_period',(select count(*) from public.data_publication where status='published' and published_at>=since_at),
    'grants_in_period',(select count(*) from public.prepackaged_dataset_download_grants where created_at>=since_at)
  ) as value from population),
  cohorts as (select date_trunc('week',created_at at time zone 'UTC')::date as week,count(*) as submitted,
    count(*) filter(where is_ready) as ready,count(*) filter(where has_error) as failed
    from population where upload_done and created_at >= (date_trunc('week',now() at time zone 'UTC')-interval '7 weeks') at time zone 'UTC'
      and created_at < (date_trunc('week',now() at time zone 'UTC')+interval '1 week') at time zone 'UTC' group by 1)
  select jsonb_build_object('as_of',now(),'since',since_at,'counts',(select value from counts),
    'workers',coalesce((select jsonb_agg(jsonb_build_object('worker_id',q.claimed_by,'dataset_id',q.dataset_id,
      'claimed_at',q.claimed_at,'task_types',q.task_types,'last_signal_at',r.last_signal_at) order by q.claimed_at)
      from public.v2_queue q join population r on r.dataset_id=q.dataset_id where q.is_processing),'[]'::jsonb),
    'cohorts',coalesce((select jsonb_agg(to_jsonb(c) order by week desc) from cohorts c),'[]'::jsonb),
    'coverage',jsonb_build_array(
      'Readiness is based on current stage flags, not a new completion event or an output accessibility test.',
      'Submission cohorts use dataset creation dates and current upload-done flags; exact upload completion times are unavailable.',
      'Queue claims and database signals do not prove live worker progress. Complete attempt history and processing lead times are unavailable.',
      'Task purpose is unknown without durable provenance; reruns and enrichment are not counted as new submissions.',
      'Validated reference patches are a current stock, not validations during this period. Audit counts use the latest recorded review time.',
      'Download grants are requests, not completed transfers. Abandoned uploads are not measured.',
      'Notification sent means recorded sent state, not delivery, opening or reading. Publication dates may include historical backfills.'
    )) into result;
  return result;
end;
$$;

revoke all on function public.factory_datasets(jsonb,integer,integer), public.factory_overview(integer) from public,anon;
grant execute on function public.factory_datasets(jsonb,integer,integer), public.factory_overview(integer) to authenticated;
comment on column public.privileged_users.can_operate is 'Trusted internal Factory metadata access across datasets. Does not grant imagery access or operational writes.';
notify pgrst, 'reload schema';
commit;
