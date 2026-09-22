\pset pager off
begin;
set local statement_timeout='45s';
insert into auth.users(id,email) select ('abcdef00-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid,'perf-'||i||'@example.invalid' from generate_series(1,1000)i;
insert into privileged_users(user_id,can_operate) values('abcdef00-0000-4000-8000-000000000001',true);
insert into v2_datasets(id,user_id,file_name,license,platform,data_access,created_at)
select 800000000+i,('abcdef00-0000-4000-8000-'||lpad((1+i%1000)::text,12,'0'))::uuid,'perf-'||i||'.tif','CC BY','drone','private',now()-interval '30 days'+i*interval '1 minute' from generate_series(1,:n)i;
insert into v2_statuses(dataset_id,is_upload_done,is_ortho_done,is_metadata_done,is_cog_done,is_thumbnail_done,is_combined_model_done,has_error)
select id,false,true,true,true,true,true,id%20=0 from v2_datasets where id>800000000;
insert into factory_submissions(dataset_id,uploaded_at,workflow,input_bytes,first_ready_at)
select id,created_at,'geotiff',536870912,case when id%10<>0 then created_at+interval '30 minutes' end from v2_datasets where id>800000000;
insert into factory_failure_episodes(dataset_id,failed_at) select dataset_id,uploaded_at+interval '10 minutes' from factory_submissions where dataset_id>800000000 and dataset_id%20=0;
insert into v2_logs(id,dataset_id,created_at,level,category,message,extra) select -((d.id-800000000)*100+i),d.id,d.created_at+i*interval '1 minute','INFO',case when i=1 then 'upload' else 'process' end,case when i=1 then 'Upload completed successfully for dataset '||d.id else repeat('synthetic log ',50) end,case when i=1 then jsonb_build_object('file_size',536870912) else null end from v2_datasets d cross join generate_series(1,10)i where d.id>800000000;
insert into processing_notification_events(queue_task_id,dataset_id,event_type,recipient_user_id,recipient_email,status,created_at)
select d.id*10+i,d.id,'processing_completed',d.user_id,'perf@example.invalid','sent',d.created_at+i*interval '1 hour' from v2_datasets d cross join generate_series(1,2)i where d.id>800000000;
analyze v2_datasets; analyze v2_statuses; analyze factory_submissions; analyze factory_failure_episodes; analyze v2_logs; analyze processing_notification_events; analyze auth.users;
select set_config('request.jwt.claims','{"sub":"abcdef00-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
\echo DATASETS
savepoint probe;
explain(analyze,buffers,summary) select factory_datasets('{}',50,0);
rollback to probe;
\echo ATTENTION
savepoint probe;
explain(analyze,buffers,summary) select factory_datasets('{"attention":true,"sort":"attention"}',50,0);
rollback to probe;
\echo IDS
savepoint probe;
explain(analyze,buffers,summary) select factory_datasets('{"ids":[800000001,800000002]}',50,0);
rollback to probe;
\echo OPERATIONS
savepoint probe;
explain(analyze,buffers,summary) select factory_operations();
rollback to probe;
\echo OVERVIEW
savepoint probe;
explain(analyze,buffers,summary) select factory_overview(7);
rollback to probe;
\echo TRENDS
savepoint probe;
explain(analyze,buffers,summary) select factory_trends();
rollback to probe;
\echo HISTORY
savepoint probe;
explain(analyze,buffers,summary) select factory_history();
rollback to probe;
\echo HISTORY_DRILLDOWN
savepoint probe;
explain(analyze,buffers,summary) select factory_datasets('{"metric":"historical_uploaded","archived":"all"}',50,0);
rollback to probe;
\echo JOURNEY
savepoint probe;
explain(analyze,buffers,summary) select factory_journey();
rollback to probe;
\echo ACTIVITY
savepoint probe;
explain(analyze,buffers,summary) select factory_activity('all',50,0);
rollback to probe;
\echo DETAIL
savepoint probe;
explain(analyze,buffers,summary) select factory_dataset(800000001);
rollback to probe;

\echo DEEP_DATASETS
savepoint probe;
explain(analyze,buffers,summary) select factory_datasets('{}',50,9000);
rollback to probe;
\echo SEARCH
savepoint probe;
explain(analyze,buffers,summary) select factory_datasets('{"search":"perf-99"}',50,0);
rollback to probe;
\echo METRIC
savepoint probe;
explain(analyze,buffers,summary) select factory_datasets('{"metric":"recorded_completed","metric_after":"2020-01-01","metric_before":"2030-01-01"}',50,0);
rollback to probe;
\echo DEEP_ACTIVITY
savepoint probe;
explain(analyze,buffers,summary) select factory_activity('all',50,9000);
rollback to probe;
rollback;
