-- Synthetic, local-only operational scenarios. Apply through seed.sh qa-factory.
begin;
insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,
  confirmation_token,recovery_token,email_change_token_new,email_change,phone_change,phone_change_token,email_change_token_current,reauthentication_token)
values ('00000000-0000-0000-0000-000000000000','00000000-0000-4000-8000-00000000a004','authenticated','authenticated',
  'qa-operator-local@example.com',crypt('DeadTreesQA-Local-1!',gen_salt('bf')),now(),'{"provider":"email","providers":["email"]}','{}',now(),now(),'','','','','','','','')
on conflict(id) do update set encrypted_password=excluded.encrypted_password;
insert into auth.identities (id,provider_id,user_id,identity_data,provider,last_sign_in_at,created_at,updated_at)
select id,id::text,id,jsonb_build_object('sub',id::text,'email',email,'email_verified',true),'email',now(),now(),now()
from auth.users where id='00000000-0000-4000-8000-00000000a004' on conflict do nothing;
delete from public.privileged_users where user_id='00000000-0000-4000-8000-00000000a004';
insert into public.privileged_users (user_id,can_operate,can_audit,can_view_all_private,can_upload_private)
values ('00000000-0000-4000-8000-00000000a004',true,false,false,false);

delete from public.data_publication where id=93001;
delete from public.v2_datasets where id between 93001 and 93120;
insert into public.v2_datasets (id,user_id,file_name,license,platform,data_access,created_at)
select i,'00000000-0000-4000-8000-00000000a004','QA-factory-'||i||'.tif','CC BY','drone','private',now()-make_interval(hours=>(93121-i)*2)
from generate_series(93001,93120) i;
insert into public.v2_statuses (dataset_id,is_upload_done,is_ortho_done,is_metadata_done,is_cog_done,is_thumbnail_done,is_combined_model_done,has_error,error_message,current_status)
select id,true,id>=93020,id>=93020,id>=93020,id>=93020,id>=93020,id in (93003,93120),
  case when id in(93003,93120) then 'Synthetic QA failure: input metadata needs investigation.' end,
  case when id=93001 then 'odm_processing'::public.v2_status when id=93004 then 'cog_processing'::public.v2_status else 'idle'::public.v2_status end
from public.v2_datasets where id between 93001 and 93120;
insert into public.v2_queue (dataset_id,user_id,is_processing,claimed_by,claimed_at,task_types,created_at)
select id,user_id,id=93001,case when id=93001 then 'qa-worker-1' end,case when id=93001 then now()-interval '3 hours' end,array['geotiff','embedding'],now()-interval '4 hours'
from public.v2_datasets where id in (93001,93002,93005,93006);
insert into public.v2_logs (dataset_id,level,message,category)
values (93001,'INFO','Synthetic QA: processing input; worker progress is not verified.','processing'),(93120,'ERROR','Synthetic QA: metadata stage failed.','processing');
insert into public.processing_notification_events (queue_task_id,dataset_id,event_type,recipient_user_id,recipient_email,status,delivery_attempts,delivery_error)
values (9300199,93120,'processing_failed','00000000-0000-4000-8000-00000000a004','qa-operator-local@example.com','failed',3,'Synthetic QA delivery failure.');
insert into public.dataset_flags (dataset_id,created_by,is_prediction_issue,description)
values (93119,'00000000-0000-4000-8000-00000000a004',true,'Synthetic QA: contributor reports a missing prediction area.');
insert into public.data_publication (id,title,user_id,status,doi,published_at)
values (93001,'Synthetic QA publication','00000000-0000-4000-8000-00000000a004','published','10.9999/factory-qa',now());
insert into public.jt_data_publication_datasets (publication_id,dataset_id) values (93001,93118);
-- Synthetic time-series history; this is a local QA fixture, never a backfill.
-- Only the isolated seed runner may write historical milestone timestamps.
update public.factory_measurement_epoch set started_at=date_trunc('week',now())-interval '10 weeks',
 activation_started_at=date_trunc('week',now())-interval '10 weeks';
update public.v2_datasets set created_at=now()-make_interval(hours=>((93121-id)*12)::integer),
  file_name='QA-factory-'||id||case when id%4=0 then '.zip' else '.tif' end
where id between 93001 and 93120;
update public.v2_statuses set is_odm_done=true where dataset_id between 93001 and 93120;
delete from public.factory_submissions where dataset_id between 93001 and 93120;
insert into public.factory_submissions(dataset_id,uploaded_at,workflow,input_bytes,first_ready_at)
select d.id,d.created_at+interval '5 minutes',case when d.id%4=0 then 'odm' else 'geotiff' end,
 case when d.id%17=0 then null when d.id%4=0 then 8589934592 else 536870912 end,
 case when s.is_combined_model_done and not s.has_error then d.created_at+interval '5 minutes'+make_interval(mins=>(30+(93121-d.id)*3)::integer) end
from public.v2_datasets d join public.v2_statuses s on s.dataset_id=d.id where d.id between 93001 and 93120;
-- Status inserts above already opened episodes; replace them with the scenario's history.
delete from public.factory_failure_episodes where dataset_id between 93001 and 93120;
insert into public.factory_failure_episodes(dataset_id,failed_at,recovered_at)
select m.dataset_id,m.uploaded_at+interval '20 minutes',m.first_ready_at
from public.factory_submissions m where m.dataset_id between 93001 and 93120 and (m.dataset_id%9=0 or m.dataset_id in(93003,93120));
insert into public.processing_notification_events(queue_task_id,dataset_id,event_type,recipient_user_id,recipient_email,task_types,created_at,status)
select d.id*100,d.id,'processing_completed',d.user_id,'qa-operator-local@example.com',
  case when d.id%2=0 then array['geotiff','embeddings_v1'] else array['geotiff','cog','deadwood_treecover_combined_v2'] end,
  m.first_ready_at,'sent'
from public.v2_datasets d join public.factory_submissions m on m.dataset_id=d.id
where d.id between 93001 and 93120 and m.first_ready_at is not null;
-- Synthetic contributors make elapsed and incomplete cohorts visible in local QA.
insert into auth.users(id,email)
select ('00000000-0000-4000-8001-'||lpad(i::text,12,'0'))::uuid,'factory-cohort-'||i||'@example.invalid'
from generate_series(0,11) i on conflict(id) do nothing;
update public.v2_datasets set user_id=('00000000-0000-4000-8001-'||lpad(((id-93001)/10)::text,12,'0'))::uuid
where id between 93001 and 93120;
insert into public.factory_result_views(dataset_id,user_id,viewed_at)
select m.dataset_id,d.user_id,m.first_ready_at+interval '2 hours'
from public.factory_submissions m join public.v2_datasets d on d.id=m.dataset_id
where m.dataset_id between 93001 and 93120 and m.first_ready_at is not null and m.dataset_id%3<>0
on conflict(dataset_id) do nothing;
-- Legacy evidence exercises reconstruction without inventing first-readiness.
update public.v2_datasets set created_at=now()-interval '1 year'-make_interval(months=>(id-93020)::integer)
where id between 93020 and 93022;
delete from public.factory_submissions where dataset_id between 93020 and 93022;
delete from public.factory_result_views where dataset_id between 93020 and 93022;
insert into public.v2_logs(dataset_id,created_at,level,category,message,extra)
select id,created_at+interval '5 minutes','INFO','upload','Upload completed successfully for dataset '||id,
 jsonb_build_object('file_size',536870912) from public.v2_datasets where id between 93020 and 93022;
update public.processing_notification_events n set created_at=d.created_at+interval '2 hours'
from public.v2_datasets d where d.id=n.dataset_id and d.id between 93020 and 93022;
update public.processing_notification_events set sent_at=created_at+interval '1 minute'
where dataset_id between 93001 and 93120 and status='sent';
-- Datasets registered before measurement, described only by retained upload and
-- processor logs: quick results, queue backlogs, failed first results (some later
-- recovered, some still failing) and failed-then-recovered reruns.
delete from public.v2_datasets where id between 93201 and 93300;
insert into public.v2_datasets (id,user_id,file_name,license,platform,data_access,created_at)
select i,('00000000-0000-4000-8001-'||lpad((i%12)::text,12,'0'))::uuid,'QA-history-'||i||case when i%4=0 then '.zip' else '.tif' end,
 'CC BY','drone','private',date_trunc('week',now())-interval '10 weeks'-make_interval(days=>((93301-i)*3)::int)
from generate_series(93201,93300) i;
insert into public.v2_statuses (dataset_id,is_upload_done,is_odm_done,is_ortho_done,is_metadata_done,is_cog_done,is_thumbnail_done,is_combined_model_done,has_error,error_message,current_status)
select id,true,true,id%9<>0,true,id%9<>0,id%9<>0,id%9<>0,id%9=0,case when id%9=0 then 'Synthetic QA failure: reconstruction stage failed.' end,'idle'
from public.v2_datasets where id between 93201 and 93300;
-- These datasets were already failing when every dataset became observed.
update public.factory_failure_episodes set failed_at=null where dataset_id between 93201 and 93300;
insert into public.v2_logs(dataset_id,created_at,level,category,message,extra)
select d.id,d.created_at+interval '5 minutes','INFO','upload','Upload completed successfully for dataset '||d.id,
 jsonb_build_object('file_size',case when d.id%4=0 then 4294967296+(d.id%3)*1073741824 else 268435456+(d.id%5)*134217728 end)
from public.v2_datasets d where d.id between 93201 and 93300;
with runs as (
 select d.id,r.n,d.created_at+case when d.id%4=0 then make_interval(days=>(1+d.id%12)::int) else make_interval(mins=>(20+(d.id%7)*15)::int) end
  +make_interval(days=>((r.n-1)*2)::int) as started_at,
  case when d.id%9=0 then 'failed' when r.n=1 and d.id%7=0 then 'failed' else 'ok' end as outcome
 from public.v2_datasets d cross join lateral (select generate_series(1,case when d.id%7=0 and d.id%9<>0 then 2 else 1 end) as n) r
 where d.id between 93201 and 93300
 union all
 -- A later search-indexing rerun that fails and then succeeds.
 select d.id,10+r.n,d.created_at+interval '30 days'+make_interval(days=>r.n::int),case r.n when 1 then 'failed' else 'rerun' end
 from public.v2_datasets d cross join generate_series(1,2) r(n) where d.id between 93201 and 93300 and d.id%5=0 and d.id%9<>0
)
-- Start logs carry the requested task types, as the processor logs them; failures
-- name their stage. Runs 11 and 12 are search-indexing reruns.
insert into public.v2_logs(dataset_id,created_at,level,category,message,extra)
select id,started_at,'INFO','process','Starting processing for task '||(id*100+n),
 jsonb_build_object('task_types',case when n>10 then '["geotiff","embeddings_v1"]'::jsonb
  when id%4=0 then '["odm_processing","geotiff","metadata","cog","thumbnail","deadwood_treecover_combined_v2"]'::jsonb
  else '["geotiff","metadata","cog","thumbnail","deadwood_treecover_combined_v2"]'::jsonb end) from runs
union all select id,started_at+interval '4 minutes','INFO','metadata','Processed metadata successfully',null from runs where n<10
union all select id,started_at+make_interval(mins=>(25+(id%4)*10)::int),'INFO','deadwood','Combined segmentation completed successfully',null from runs where outcome='ok'
union all select id,started_at+interval '3 minutes','INFO','embeddings','Tile embedding completed successfully',null from runs where outcome='rerun'
union all select id,started_at+interval '6 minutes','ERROR','process',
 'Processing failed: '||case when n>10 then 'embedding_processing' else 'deadwood_treecover_combined_segmentation' end||' processing failed: synthetic QA stage failure',null
from runs where outcome='failed';
commit;
