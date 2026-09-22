-- One attention definition powers the overview, explorer and copied evidence.
begin;
create view public.factory_attention_records with (security_invoker=true) as
select r.*,reason.value as attention_reason,
 case reason.value when 'failed' then failure.since when 'uncertain' then s.updated_at
 when 'overdue' then m.uploaded_at when 'delivery' then delivery.since
 when 'report' then report.since when 'silent' then r.last_signal_at end as attention_since,
 case reason.value when 'failed' then 1 when 'uncertain' then 2 when 'overdue' then 3
 when 'delivery' then 4 when 'report' then 5 when 'silent' then 6 end as attention_rank,
 failure.since as failure_since,delivery.since as delivery_since,report.since as report_since
from public.factory_dataset_records r
left join public.v2_statuses s on s.dataset_id=r.dataset_id
left join public.factory_submissions m on m.dataset_id=r.dataset_id
left join lateral(select min(failed_at) as since from public.factory_failure_episodes where dataset_id=r.dataset_id and recovered_at is null) failure on true
left join lateral(select min(created_at) as since from public.processing_notification_events where dataset_id=r.dataset_id
 and (status='failed' or (status in ('pending','sending') and next_attempt_at<now()))) delivery on true
left join lateral(select min(created_at) as since from public.dataset_flags where dataset_id=r.dataset_id and status<>'resolved') report on true
cross join lateral(select case
 when r.has_error and r.state<>'claimed' then 'failed'
 when r.state='uncertain' then 'uncertain'
 when m.first_ready_at is null and m.workflow='geotiff' and m.input_bytes<1073741824 and m.uploaded_at<now()-interval '2 hours' then 'overdue'
 when r.notification_problem then 'delivery'
 when r.open_reports>0 then 'report'
 when r.state='claimed' and r.last_signal_at<now()-interval '1 hour' then 'silent'
 end as value) reason;
revoke all on public.factory_attention_records from public,anon,authenticated;

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
    or exists(select 1 from public.factory_attention_records a where a.dataset_id=r.dataset_id and a.attention_reason is not null));
$$;
create or replace function public.factory_datasets(p_filters jsonb default '{}',p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; attention_sort boolean:=coalesce(p_filters->>'sort','newest')='attention';
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 if p_filters is null or jsonb_typeof(p_filters)<>'object' or p_limit is null or p_limit<1 or p_limit>500
 or p_offset is null or p_offset<0 or coalesce(p_filters->>'sort','newest') not in ('newest','attention') then
 raise exception 'Invalid Factory pagination or filters' using errcode='22023'; end if;
 with filtered as materialized(select a.* from public.factory_filtered_datasets(p_filters) f join public.factory_attention_records a using(dataset_id)),
 page as(select * from filtered order by case when attention_sort then attention_rank end nulls last,
 case when attention_sort then attention_since end nulls last,dataset_id desc limit p_limit offset p_offset)
 select jsonb_build_object('as_of',now(),'total',(select count(*) from filtered),'items',coalesce((select jsonb_agg(to_jsonb(page)
 order by case when attention_sort then attention_rank end nulls last,case when attention_sort then attention_since end nulls last,dataset_id desc) from page),'[]'::jsonb)) into result;
 return result;
end;
$$;

create function public.factory_operations() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 with population as materialized(select * from public.factory_attention_records where not archived),
 attention as(select * from population where attention_reason is not null),
 top_attention as(select * from attention order by attention_rank,attention_since nulls last,dataset_id desc limit 10),
 waiting as(
 select 1 as position,'queued' as key,count(*) as count,min(queued_at) as oldest_at,'Oldest queue entry' as age_label,'{"state":"queued"}'::jsonb as filters from population where state='queued'
 union all select 2,'processing',count(*),min(claimed_at),'Oldest claim','{"state":"claimed"}'::jsonb from population where state='claimed'
 union all select 3,'failed',count(*),min(failure_since),'Oldest recorded open failure','{"has_error":true}'::jsonb from population where has_error
 union all select 4,'delivery',count(*),min(delivery_since),'Oldest notification with a delivery problem','{"notification":"problem"}'::jsonb from population where notification_problem
 union all select 5,'reports',count(*),min(report_since),'Oldest open report','{"reports":"open"}'::jsonb from population where open_reports>0
 ) select jsonb_build_object('as_of',now(),'attention_total',(select count(*) from attention),
 'attention_contributors',(select count(distinct user_id) from attention),
 'attention',coalesce((select jsonb_agg(to_jsonb(top_attention) order by attention_rank,attention_since nulls last,dataset_id desc) from top_attention),'[]'::jsonb),
 'waiting',(select jsonb_agg(to_jsonb(waiting)-'position' order by position) from waiting),
 'coverage',jsonb_build_array(
 'Attention order: recorded failure without an active claim, uncertain status, qualifying overdue first result, delivery problem, open report, then silent claim. Within each reason, known oldest timestamps come first; missing ages remain unknown.',
 'Overdue means upload-to-first-result exceeds two hours for tracked GeoTIFF inputs under 1 GiB. This is not a queue-only deadline and never cancels work.',
 'A silent claim has no recorded database signal for over an hour; a legitimate long stage can look the same. It does not prove a stuck worker.',
 'Queue, claim, failure, notification and report ages use different clocks. Oldest known failure excludes legacy failures without a measured start.',
 'Waiting groups overlap. Counts and ages identify work to investigate, not proven stage capacity or the system constraint. Per-stage wait history and live worker heartbeat are unavailable.'
 )) into result;
 return result;
end;
$$;
revoke all on function public.factory_operations() from public,anon;
grant execute on function public.factory_operations() to authenticated;
notify pgrst,'reload schema';
commit;
