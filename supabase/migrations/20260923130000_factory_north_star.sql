-- North-star outcomes for the Factory overview: is the platform doing its job,
-- week over week? Team accounts (auditors) are excluded unless requested.
begin;

-- Dataset download requests that passed authentication and access checks. The
-- file itself is served statically, so a completed transfer is not observable.
create table public.dataset_download_requests (
 id bigint generated always as identity primary key,
 dataset_id bigint not null references public.v2_datasets(id) on delete cascade,
 user_id uuid references auth.users(id) on delete set null,
 kind text not null check(kind in ('dataset','labels','bundle')),
 requested_at timestamptz not null default clock_timestamp()
);
create index dataset_download_requests_time_idx on public.dataset_download_requests(requested_at);
create index dataset_download_requests_dataset_idx on public.dataset_download_requests(dataset_id);
alter table public.dataset_download_requests enable row level security;
revoke all on public.dataset_download_requests from public,anon,authenticated;
comment on table public.dataset_download_requests is 'One row per accepted download request (API writes with the service role after access and output checks). Coverage starts at the first recorded row.';
-- Older rate-limit logs are written before the access and output checks, so they
-- cannot prove a request was accepted and are not backfilled.

create function public.factory_north_star(p_include_team boolean default false)
returns jsonb language plpgsql stable security definer set search_path='' set timezone='UTC' set jit=off as $$
declare result jsonb; run_since timestamptz; download_since timestamptz; week_start timestamptz; month_start timestamptz;
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 if p_include_team is null then raise exception 'Invalid Factory team filter' using errcode='22023'; end if;
 -- Completion times exist only since notifications were recorded. Uploads before
 -- that may have been completed long ago and rerun later, so they never count.
 select min(created_at) into run_since from public.processing_notification_events
  where event_type='processing_completed' and created_at<=now();
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
 ), completions as materialized (
  select dataset_id,min(created_at) as completed_at from public.processing_notification_events
  where event_type='processing_completed' and created_at<=now() group by dataset_id
 ), results as materialized (
  -- Directly measured first readiness wins; otherwise the first recorded completion.
  select u.*,m.dataset_id is not null or u.uploaded_at>=run_since as observable,
   case when m.dataset_id is not null then m.first_ready_at
    when u.uploaded_at>=run_since and c.completed_at>=u.uploaded_at then c.completed_at end as result_at
  from uploads u
  left join public.factory_submissions m on m.dataset_id=u.dataset_id
  left join completions c on c.dataset_id=u.dataset_id
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
  select r.requested_at,r.user_id is distinct from d.user_id as reuse
  from public.dataset_download_requests r join public.v2_datasets d on d.id=r.dataset_id
  where r.requested_at>=week_start and r.requested_at<=now()
   and not exists(select 1 from team t where t.user_id=r.user_id)
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
   'Complete results count each dataset once, at its first complete result: measured readiness where available, otherwise the first recorded completion notification after upload. Uploads before completion notifications were recorded are never counted, because their first recorded completion may be a rerun.',
   'Upload times come from direct measurement or upload logs; older datasets fall back to their registration time.',
   'Never reached within 7 days groups uploads by upload week and includes late results. The stage breakdown shows where those uploads stand now, not where they first failed.',
   'Reference data counts audits whose final assessment is no issues. Fixable and excluded datasets are not counted. Audits count by audit date.',
   'Downloads are accepted download requests, not completed transfers. Reuse means someone other than the dataset owner. Coverage starts with the first request the API recorded; earlier weeks are unknown, and that first week is a lower bound. Older request logs were written before access checks and are not used.',
   'Activation and retention use monthly cohorts and only count elapsed windows. A return upload must be on a later day, so one batch is one visit. Deleted datasets and accounts are absent.'
  )) into result;
 return result;
end;
$$;
revoke all on function public.factory_north_star(boolean) from public,anon;
grant execute on function public.factory_north_star(boolean) to authenticated;
notify pgrst,'reload schema';
commit;
