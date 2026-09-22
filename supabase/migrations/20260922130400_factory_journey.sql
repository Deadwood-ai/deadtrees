-- Prospective consented owner-result observations and an operator-only journey.
begin;
alter table public.factory_measurement_epoch add column activation_started_at timestamptz not null default clock_timestamp();
create table public.factory_result_views (
 dataset_id bigint primary key references public.factory_submissions(dataset_id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 viewed_at timestamptz not null default clock_timestamp()
);
alter table public.factory_result_views enable row level security;
revoke all on public.factory_result_views from public,anon,authenticated;

-- The browser only calls this after analytics consent. Do not accept a supplied
-- identity or timestamp, or count operator inspection as contributor activation.
create function public.factory_record_result_view(p_dataset_id bigint) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 insert into public.factory_result_views(dataset_id,user_id)
 select d.id,d.user_id from public.v2_datasets d
 join public.factory_submissions m on m.dataset_id=d.id
 join public.v2_statuses s on s.dataset_id=d.id
 where d.id=p_dataset_id and d.user_id=auth.uid() and m.first_ready_at is not null
 and public.factory_status_ready(s,d.file_name)
 on conflict(dataset_id) do nothing;
end;
$$;
revoke all on function public.factory_record_result_view(bigint) from public,anon;
grant execute on function public.factory_record_result_view(bigint) to authenticated;

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
 ), contributors as (
  select f.*,v.viewed_at,
   exists(select 1 from population p where p.user_id=f.user_id and p.dataset_id<>f.dataset_id
    and p.uploaded_at>f.uploaded_at and p.uploaded_at<=f.uploaded_at+interval '30 days') as returned,
   f.uploaded_at>=activation_epoch and f.uploaded_at<=now()-interval '7 days' as activation_eligible,
   f.uploaded_at<=now()-interval '30 days' as retention_eligible
  from first_upload f left join public.factory_result_views v on v.dataset_id=f.dataset_id and v.user_id=f.user_id
  where not exists(select 1 from public.v2_datasets d join public.v2_statuses s on s.dataset_id=d.id
   where d.user_id=f.user_id and s.is_upload_done and not exists(select 1 from public.factory_submissions m where m.dataset_id=d.id))
 ), cohorts as (
  select date_trunc('week',uploaded_at) as week,count(*) as contributors,
   count(*) filter(where activation_eligible) as activation_eligible,
   case when count(*) filter(where activation_eligible)>0 then count(*) filter(where activation_eligible and viewed_at<=uploaded_at+interval '7 days') end as activated_7d,
   count(*) filter(where retention_eligible) as retention_eligible,
   case when count(*) filter(where retention_eligible)>0 then count(*) filter(where retention_eligible and returned) end as returned_30d
  from contributors group by 1
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
revoke all on function public.factory_journey() from public,anon;
grant execute on function public.factory_journey() to authenticated;
notify pgrst,'reload schema';
commit;
