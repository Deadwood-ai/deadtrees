begin;

create function public.factory_dataset(p_dataset_id bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare dataset jsonb; result jsonb;
begin
  if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
  select to_jsonb(r) into dataset from public.factory_dataset_records r where dataset_id=p_dataset_id;
  if dataset is null then raise exception 'Dataset not found' using errcode='P0002'; end if;
  select jsonb_build_object('as_of',now(),'dataset',dataset,
    'status',(select to_jsonb(s) || coalesce(to_jsonb(m)-'dataset_id','{}'::jsonb)
      from public.v2_statuses s left join public.factory_submissions m on m.dataset_id=s.dataset_id where s.dataset_id=p_dataset_id),
    'queue',coalesce((select jsonb_agg(to_jsonb(q)) from (
      select id,created_at,is_processing,priority,task_types,claimed_by,claimed_at
      from public.v2_queue where dataset_id=p_dataset_id order by created_at desc,id desc) q),'[]'::jsonb),
    'logs',coalesce((select jsonb_agg(to_jsonb(l)) from (
      select id,created_at,level,category,left(message,4000) as message
      from public.v2_logs where dataset_id=p_dataset_id order by created_at desc,id desc limit 200) l),'[]'::jsonb),
    'log_total',(select count(*) from public.v2_logs where dataset_id=p_dataset_id),
    'outputs',jsonb_build_object(
      'orthos',coalesce((select jsonb_agg(to_jsonb(o)) from (select version,created_at,ortho_file_size,ortho_upload_runtime from public.v2_orthos where dataset_id=p_dataset_id) o),'[]'::jsonb),
      'cogs',coalesce((select jsonb_agg(to_jsonb(o)) from (select version,created_at,cog_file_size,cog_processing_runtime from public.v2_cogs where dataset_id=p_dataset_id) o),'[]'::jsonb),
      'thumbnails',coalesce((select jsonb_agg(to_jsonb(o)) from (select version,created_at,thumbnail_file_size,thumbnail_processing_runtime from public.v2_thumbnails where dataset_id=p_dataset_id) o),'[]'::jsonb),
      'raw_images',coalesce((select jsonb_agg(to_jsonb(o)) from (select version,created_at,raw_image_count,raw_image_size_mb from public.v2_raw_images where dataset_id=p_dataset_id) o),'[]'::jsonb)),
    'notifications',coalesce((select jsonb_agg(to_jsonb(n)) from (
      select id,event_type,status,recipient_roles,delivery_attempts,next_attempt_at,sent_at,created_at,left(delivery_error,2000) as delivery_error
      from public.processing_notification_events where dataset_id=p_dataset_id order by created_at desc,id desc) n),'[]'::jsonb),
    'publications',coalesce((select jsonb_agg(to_jsonb(p)) from (
      select p.id,p.status,p.doi,p.created_at,p.published_at from public.data_publication p
      join public.jt_data_publication_datasets j on j.publication_id=p.id where j.dataset_id=p_dataset_id order by p.created_at desc,p.id desc) p),'[]'::jsonb),
    'reports',coalesce((select jsonb_agg(to_jsonb(f)) from (
      select id,concat_ws(', ',case when is_ortho_mosaic_issue then 'orthomosaic' end,case when is_prediction_issue then 'prediction' end) as flag_type,
      status,created_at,updated_at,left(description,4000) as description,left(auditor_comment,2000) as auditor_comment
      from public.dataset_flags where dataset_id=p_dataset_id order by created_at desc,id desc) f),'[]'::jsonb),
    'audits',coalesce((select jsonb_agg(to_jsonb(a)) from (select audit_date,reviewed_at,final_assessment,has_major_issue,notes
      from public.dataset_audit where dataset_id=p_dataset_id) a),'[]'::jsonb),
    'corrections',coalesce((select jsonb_agg(to_jsonb(c)) from (select id,layer_type,operation,created_at,review_status,reviewed_at
      from public.v2_geometry_corrections where dataset_id=p_dataset_id order by created_at desc,id desc limit 200) c),'[]'::jsonb),
    'correction_total',(select count(*) from public.v2_geometry_corrections where dataset_id=p_dataset_id)
  ) into result;
  return result;
end;
$$;

-- Recorded activity only. Upload rows describe creation plus current flags;
-- processing rows describe logs, not a complete attempt ledger.
create function public.factory_activity(p_kind text default 'all',p_limit integer default 50,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
  if p_kind is null or p_kind not in ('all','uploads','processing','notifications','publications','reports')
    or p_limit is null or p_limit<1 or p_limit>500 or p_offset is null or p_offset<0
    then raise exception 'Invalid Factory activity query' using errcode='22023'; end if;
  with events as (
    select 'uploads'::text as kind,d.id::text as id,d.id as dataset_id,d.created_at,
      case when s.is_upload_done then 'upload_done' else 'incomplete' end as state,d.file_name::text as summary
      from public.v2_datasets d left join public.v2_statuses s on s.dataset_id=d.id where p_kind in ('all','uploads')
    union all select 'processing',l.id::text,l.dataset_id,l.created_at,l.level::text,left(l.message,500)
      from public.v2_logs l where l.dataset_id is not null and p_kind in ('all','processing')
    union all select 'notifications',n.id::text,n.dataset_id,n.created_at,n.status,n.event_type
      from public.processing_notification_events n where p_kind in ('all','notifications')
    union all select 'publications',p.id::text,null::bigint,p.created_at,p.status::text,coalesce(p.doi,p.title,'Publication record')
      from public.data_publication p where p_kind in ('all','publications')
    union all select 'reports',f.id::text,f.dataset_id,f.created_at,f.status,left(f.description,500)
      from public.dataset_flags f where p_kind in ('all','reports')
  ), page as (select * from events order by created_at desc,kind,id desc limit p_limit offset p_offset)
  select jsonb_build_object('as_of',now(),'total',(select count(*) from events),
    'items',coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc,kind,id desc) from page p),'[]'::jsonb)) into result;
  return result;
end;
$$;
revoke all on function public.factory_dataset(bigint), public.factory_activity(text,integer,integer) from public,anon;
grant execute on function public.factory_dataset(bigint), public.factory_activity(text,integer,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
