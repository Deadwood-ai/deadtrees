-- Audit Review: the saved legacy audits are detached from every workflow (2 of 2, DT-1606).
--
-- - The export view, the factory read model, the factory dataset page and the north star
--   read the evaluation decision ("audited ok" is the decision keep).
-- - Writes stop: the legacy write policy, the lease guard and the date decision trigger on
--   the legacy table (read-only history now; its decisions live on in
--   audit.legacy_decisions), the monitoring role's grant, public.audit_review_queue,
--   public.dataset_audit_suggestions (dropped: the checks report in the audit schema), and
--   the acquisition date decisions (rows kept as history: the date check only advises
--   replace or keep and never changes v2_datasets). The review lease
--   (dataset_audit_locks) stays for the Audit Review page.
-- - User reports and suggested prediction edits are not part of the audit: they have their
--   own page (Edits & flags), and an audit lease no longer guards them. The lease still
--   guards the audit's own writes (the manual AOI).
set local lock_timeout = '5s';


-- The export script reads it directly; "audited ok" is the decision keep.
drop view public.v_export_polygon_candidates;
create view public.v_export_polygon_candidates as
WITH correction_flags AS (
         SELECT c.layer_type,
            c.geometry_id,
            bool_or(c.operation = 'add'::text AND c.review_status = 'approved'::text) AS has_approved_add,
            bool_or(c.operation = 'modify'::text AND c.review_status = 'approved'::text) AS has_approved_modify,
            bool_or(c.operation = 'delete'::text AND c.review_status = 'approved'::text) AS has_approved_delete,
            bool_or(c.operation = 'add'::text AND (COALESCE(c.review_status, ''::text) <> ALL (ARRAY['approved'::text, 'rejected'::text]))) AS has_pending_add,
            bool_or(c.operation = 'modify'::text AND (COALESCE(c.review_status, ''::text) <> ALL (ARRAY['approved'::text, 'rejected'::text]))) AS has_pending_modify,
            bool_or(c.operation = 'delete'::text AND (COALESCE(c.review_status, ''::text) <> ALL (ARRAY['approved'::text, 'rejected'::text]))) AS has_pending_delete
           FROM v2_geometry_corrections c
          GROUP BY c.layer_type, c.geometry_id
        ), approved_replacements AS (
         SELECT c.layer_type,
            c.original_geometry_id AS geometry_id,
            true AS replaced_by_approved_modify
           FROM v2_geometry_corrections c
          WHERE c.operation = 'modify'::text AND c.review_status = 'approved'::text AND c.original_geometry_id IS NOT NULL
          GROUP BY c.layer_type, c.original_geometry_id
        ), deadwood AS (
         SELECT 'deadwood'::text AS layer_type,
            dg.id AS geometry_id,
            dg.label_id,
            l.dataset_id,
            l.label_source::text AS label_source,
            l.is_active AS label_is_active,
            COALESCE(dg.is_deleted, false) AS is_deleted_in_table,
            COALESCE(cf.has_approved_add, false) AS has_approved_add,
            COALESCE(cf.has_approved_modify, false) AS has_approved_modify,
            COALESCE(cf.has_approved_delete, false) AS has_approved_delete,
            COALESCE(cf.has_pending_add, false) AS has_pending_add,
            COALESCE(cf.has_pending_modify, false) AS has_pending_modify,
            COALESCE(cf.has_pending_delete, false) AS has_pending_delete,
            COALESCE(ar.replaced_by_approved_modify, false) AS replaced_by_approved_modify,
            dg.geometry,
            dg.area_m2,
            dg.properties,
            dg.created_at,
            dg.updated_at
           FROM v2_deadwood_geometries dg
             JOIN v2_labels l ON l.id = dg.label_id
             JOIN v2_model_preferences mp ON mp.label_data = 'deadwood'::text AND l.model_config = mp.model_config
             LEFT JOIN correction_flags cf ON cf.layer_type = 'deadwood'::text AND cf.geometry_id = dg.id
             LEFT JOIN approved_replacements ar ON ar.layer_type = 'deadwood'::text AND ar.geometry_id = dg.id
          WHERE l.label_source = 'model_prediction'::"LabelSource"
        ), forest_cover AS (
         SELECT 'forest_cover'::text AS layer_type,
            fg.id AS geometry_id,
            fg.label_id,
            l.dataset_id,
            l.label_source::text AS label_source,
            l.is_active AS label_is_active,
            COALESCE(fg.is_deleted, false) AS is_deleted_in_table,
            COALESCE(cf.has_approved_add, false) AS has_approved_add,
            COALESCE(cf.has_approved_modify, false) AS has_approved_modify,
            COALESCE(cf.has_approved_delete, false) AS has_approved_delete,
            COALESCE(cf.has_pending_add, false) AS has_pending_add,
            COALESCE(cf.has_pending_modify, false) AS has_pending_modify,
            COALESCE(cf.has_pending_delete, false) AS has_pending_delete,
            COALESCE(ar.replaced_by_approved_modify, false) AS replaced_by_approved_modify,
            fg.geometry,
            fg.area_m2,
            fg.properties,
            fg.created_at,
            fg.updated_at
           FROM v2_forest_cover_geometries fg
             JOIN v2_labels l ON l.id = fg.label_id
             JOIN v2_model_preferences mp ON mp.label_data = 'forest_cover'::text AND l.model_config = mp.model_config
             LEFT JOIN correction_flags cf ON cf.layer_type = 'forest_cover'::text AND cf.geometry_id = fg.id
             LEFT JOIN approved_replacements ar ON ar.layer_type = 'forest_cover'::text AND ar.geometry_id = fg.id
          WHERE l.label_source = 'model_prediction'::"LabelSource"
        ), resolved_polygons AS (
         SELECT p_1.layer_type,
            p_1.geometry_id AS id,
            p_1.label_id,
            p_1.dataset_id,
            p_1.label_source,
                CASE
                    WHEN p_1.has_approved_delete THEN false
                    WHEN p_1.replaced_by_approved_modify THEN false
                    WHEN p_1.has_approved_add OR p_1.has_approved_modify THEN true
                    WHEN p_1.has_pending_add OR p_1.has_pending_modify THEN false
                    WHEN p_1.has_pending_delete THEN true
                    ELSE NOT p_1.is_deleted_in_table
                END AS is_active,
            p_1.is_deleted_in_table AS is_deleted,
            NOT (p_1.has_approved_add OR p_1.has_approved_modify OR p_1.has_pending_add OR p_1.has_pending_modify) AS is_original_prediction_geometry,
            false AS has_pending_model_edits,
            'approved_state'::text AS recommended_export_mode,
            p_1.label_is_active,
            p_1.geometry,
            p_1.area_m2,
            p_1.properties,
            p_1.created_at,
            p_1.updated_at
           FROM ( SELECT deadwood.layer_type,
                    deadwood.geometry_id,
                    deadwood.label_id,
                    deadwood.dataset_id,
                    deadwood.label_source,
                    deadwood.label_is_active,
                    deadwood.is_deleted_in_table,
                    deadwood.has_approved_add,
                    deadwood.has_approved_modify,
                    deadwood.has_approved_delete,
                    deadwood.has_pending_add,
                    deadwood.has_pending_modify,
                    deadwood.has_pending_delete,
                    deadwood.replaced_by_approved_modify,
                    deadwood.geometry,
                    deadwood.area_m2,
                    deadwood.properties,
                    deadwood.created_at,
                    deadwood.updated_at
                   FROM deadwood
                UNION ALL
                 SELECT forest_cover.layer_type,
                    forest_cover.geometry_id,
                    forest_cover.label_id,
                    forest_cover.dataset_id,
                    forest_cover.label_source,
                    forest_cover.label_is_active,
                    forest_cover.is_deleted_in_table,
                    forest_cover.has_approved_add,
                    forest_cover.has_approved_modify,
                    forest_cover.has_approved_delete,
                    forest_cover.has_pending_add,
                    forest_cover.has_pending_modify,
                    forest_cover.has_pending_delete,
                    forest_cover.replaced_by_approved_modify,
                    forest_cover.geometry,
                    forest_cover.area_m2,
                    forest_cover.properties,
                    forest_cover.created_at,
                    forest_cover.updated_at
                   FROM forest_cover) p_1
        )
 SELECT p.layer_type,
    p.id,
    p.label_id,
    p.dataset_id,
    p.label_source,
    p.is_active,
    p.is_deleted,
    p.is_original_prediction_geometry,
    p.has_pending_model_edits,
    p.recommended_export_mode,
    decision.decision AS audit_decision,
    p.geometry,
    p.area_m2,
    p.properties,
    p.created_at,
    p.updated_at
   FROM resolved_polygons p
     LEFT JOIN audit.evaluation_decisions decision ON decision.dataset_id = p.dataset_id
  WHERE p.is_active AND p.label_is_active;
revoke all on table public.v_export_polygon_candidates from anon, authenticated;
grant select on table public.v_export_polygon_candidates to service_role;

-- Factory: an audit is an evaluation decision; the dataset page lists the reviewers' and
-- imported evaluation answers.
create or replace view public.factory_dataset_records with (security_invoker = true) as
SELECT d.id AS dataset_id,
    d.file_name,
    d.created_at,
    d.user_id,
    u.email::text AS user_email,
    ui.organisation,
    d.archived,
        CASE
            WHEN q.is_processing THEN 'claimed'::text
            WHEN s.has_error THEN 'failed'::text
            WHEN q.id IS NOT NULL THEN 'queued'::text
            WHEN s.current_status <> 'idle'::v2_status THEN 'uncertain'::text
            WHEN ready.value THEN 'ready'::text
            ELSE 'incomplete'::text
        END AS state,
    s.current_status::text AS stage,
    COALESCE(s.has_error, false) AS has_error,
    "left"(s.error_message, 2000) AS error_message,
    q.claimed_by AS worker_id,
    q.claimed_at,
    q.created_at AS queued_at,
    q.priority AS queue_priority,
    q.task_types,
    GREATEST(s.updated_at, ( SELECT l.created_at
           FROM v2_logs l
          WHERE l.dataset_id = d.id
          ORDER BY l.created_at DESC
         LIMIT 1), q.claimed_at) AS last_signal_at,
    ready.value AS is_ready,
    COALESCE(s.is_upload_done, false) AS upload_done,
    COALESCE(n.status, 'none'::text) AS notification_state,
    COALESCE(delivery.problem, false) AS notification_problem,
    COALESCE(pub.status, 'none'::text) AS publication_state,
    COALESCE(reports.open_reports, 0::bigint) AS open_reports,
    (EXISTS ( SELECT 1
           FROM audit.evaluation_decisions a
          WHERE a.dataset_id = d.id AND a.decision IS NOT NULL)) AS has_audit,
    'unknown'::text AS intent
   FROM v2_datasets d
     LEFT JOIN auth.users u ON u.id = d.user_id
     LEFT JOIN ( SELECT DISTINCT ON (user_info."user") user_info."user",
            user_info.organisation
           FROM user_info
          ORDER BY user_info."user", user_info.id) ui ON ui."user" = d.user_id
     LEFT JOIN v2_statuses s ON s.dataset_id = d.id
     LEFT JOIN ( SELECT DISTINCT ON (v2_queue.dataset_id) v2_queue.dataset_id,
            v2_queue.id,
            v2_queue.is_processing,
            v2_queue.claimed_by,
            v2_queue.claimed_at,
            v2_queue.created_at,
            v2_queue.priority,
            v2_queue.task_types
           FROM v2_queue
          ORDER BY v2_queue.dataset_id, v2_queue.is_processing DESC, v2_queue.priority DESC, v2_queue.created_at, v2_queue.id) q ON q.dataset_id = d.id
     LEFT JOIN ( SELECT DISTINCT ON (processing_notification_events.dataset_id) processing_notification_events.dataset_id,
            processing_notification_events.status
           FROM processing_notification_events
          ORDER BY processing_notification_events.dataset_id, processing_notification_events.created_at DESC, processing_notification_events.id DESC) n ON n.dataset_id = d.id
     LEFT JOIN ( SELECT DISTINCT ON (j.dataset_id) j.dataset_id,
            p.status
           FROM data_publication p
             JOIN jt_data_publication_datasets j ON j.publication_id = p.id
          ORDER BY j.dataset_id, p.created_at DESC, p.id DESC) pub ON pub.dataset_id = d.id
     LEFT JOIN ( SELECT processing_notification_events.dataset_id,
            true AS problem
           FROM processing_notification_events
          WHERE processing_notification_events.status = 'failed'::text OR (processing_notification_events.status = ANY (ARRAY['pending'::text, 'sending'::text])) AND processing_notification_events.next_attempt_at < now()
          GROUP BY processing_notification_events.dataset_id) delivery ON delivery.dataset_id = d.id
     LEFT JOIN ( SELECT dataset_flags.dataset_id,
            count(*) AS open_reports
           FROM dataset_flags
          WHERE dataset_flags.status <> 'resolved'::text
          GROUP BY dataset_flags.dataset_id) reports ON reports.dataset_id = d.id
     CROSS JOIN LATERAL ( SELECT factory_status_ready(s.*, d.file_name) AS value) ready;

CREATE OR REPLACE FUNCTION public.factory_dataset(p_dataset_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET jit TO 'off'
AS $function$
declare dataset jsonb; result jsonb;
begin
  if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
  select to_jsonb(r) into dataset from public.factory_dataset_records r where dataset_id=p_dataset_id;
  if dataset is null then return jsonb_build_object('as_of',now(),'dataset',null); end if;
  select jsonb_build_object('as_of',now(),'dataset',dataset,
    'status',(select to_jsonb(s) || coalesce(to_jsonb(m)-'dataset_id','{}'::jsonb)
      || coalesce((select jsonb_build_object('historical_uploaded_at',u.uploaded_at,'historical_input_bytes',u.input_bytes,'historical_upload_source',u.source)
        from public.factory_historical_uploads u where u.dataset_id=p_dataset_id),'{}'::jsonb)
      || coalesce((select jsonb_build_object('first_result_at',e.first_result_at,'first_result_source',e.result_source)
        from public.factory_outcome_evidence e where e.dataset_id=p_dataset_id),'{}'::jsonb)
      from public.v2_statuses s left join public.factory_submissions m on m.dataset_id=s.dataset_id where s.dataset_id=p_dataset_id),
    'failures',coalesce((select jsonb_agg(to_jsonb(f) order by f.failed_at desc nulls last) from (
      select failed_at,recovered_at,start_source,recovery_source,phase from public.factory_failure_evidence
      where dataset_id=p_dataset_id order by failed_at desc nulls last limit 200) f),'[]'::jsonb),
    'queue',coalesce((select jsonb_agg(to_jsonb(q)) from (
      select id,created_at,is_processing,priority,task_types,claimed_by,claimed_at
      from public.v2_queue where dataset_id=p_dataset_id order by created_at desc,id desc limit 200) q),'[]'::jsonb),
    'logs',coalesce((select jsonb_agg(to_jsonb(l)) from (
      select id,created_at,level,category,left(message,4000) as message
      from public.v2_logs where dataset_id=p_dataset_id order by created_at desc,id desc limit 200) l),'[]'::jsonb),
    'log_total',(select count(*) from public.v2_logs where dataset_id=p_dataset_id),
    'outputs',jsonb_build_object(
      'orthos',coalesce((select jsonb_agg(to_jsonb(o)) from (select version,created_at,ortho_file_size,ortho_upload_runtime from public.v2_orthos where dataset_id=p_dataset_id order by created_at desc,version desc limit 200) o),'[]'::jsonb),
      'cogs',coalesce((select jsonb_agg(to_jsonb(o)) from (select version,created_at,cog_file_size,cog_processing_runtime from public.v2_cogs where dataset_id=p_dataset_id order by created_at desc,version desc limit 200) o),'[]'::jsonb),
      'thumbnails',coalesce((select jsonb_agg(to_jsonb(o)) from (select version,created_at,thumbnail_file_size,thumbnail_processing_runtime from public.v2_thumbnails where dataset_id=p_dataset_id order by created_at desc,version desc limit 200) o),'[]'::jsonb),
      'raw_images',coalesce((select jsonb_agg(to_jsonb(o)) from (select version,created_at,raw_image_count,raw_image_size_mb from public.v2_raw_images where dataset_id=p_dataset_id order by created_at desc,version desc limit 200) o),'[]'::jsonb)),
    'notifications',coalesce((select jsonb_agg(to_jsonb(n)) from (
      select id,event_type,status,recipient_roles,delivery_attempts,next_attempt_at,sent_at,created_at,left(delivery_error,2000) as delivery_error
      from public.processing_notification_events where dataset_id=p_dataset_id order by created_at desc,id desc limit 200) n),'[]'::jsonb),
    'publications',coalesce((select jsonb_agg(to_jsonb(p)) from (
      select p.id,p.status,p.doi,p.created_at,p.published_at from public.data_publication p
      join public.jt_data_publication_datasets j on j.publication_id=p.id where j.dataset_id=p_dataset_id order by p.created_at desc,p.id desc limit 200) p),'[]'::jsonb),
    'reports',coalesce((select jsonb_agg(to_jsonb(f)) from (
      select id,concat_ws(', ',case when is_ortho_mosaic_issue then 'orthomosaic' end,case when is_prediction_issue then 'prediction' end) as flag_type,
      status,created_at,updated_at,left(description,4000) as description,left(auditor_comment,2000) as auditor_comment
      from public.dataset_flags where dataset_id=p_dataset_id order by created_at desc,id desc limit 200) f),'[]'::jsonb),
    'audit_decision',(select to_jsonb(e) from audit.evaluation_decisions e where e.dataset_id=p_dataset_id),
    'audits',coalesce((select jsonb_agg(to_jsonb(a)) from (select created_at,decision,source,notes from (
      select created_at,decision,'reviewer' as source,left(coalesce(exclude_reason||': ','')||coalesce(note,''),4000) as notes,id
      from audit.dataset_human_reviews where dataset_id=p_dataset_id and check_key='dataset_evaluation'
      union all
      select decided_at,decision,'legacy',left(reason,4000),0 from audit.legacy_decisions where dataset_id=p_dataset_id) x
      order by created_at desc,id desc limit 200) a),'[]'::jsonb),
    'corrections',coalesce((select jsonb_agg(to_jsonb(c)) from (select id,layer_type,operation,created_at,review_status,reviewed_at
      from public.v2_geometry_corrections where dataset_id=p_dataset_id order by created_at desc,id desc limit 200) c),'[]'::jsonb),
    'record_totals',jsonb_build_object('queue',(select count(*) from public.v2_queue where dataset_id=p_dataset_id),
      'orthos',(select count(*) from public.v2_orthos where dataset_id=p_dataset_id),
      'cogs',(select count(*) from public.v2_cogs where dataset_id=p_dataset_id),
      'thumbnails',(select count(*) from public.v2_thumbnails where dataset_id=p_dataset_id),
      'raw_images',(select count(*) from public.v2_raw_images where dataset_id=p_dataset_id),
      'notifications',(select count(*) from public.processing_notification_events where dataset_id=p_dataset_id),
      'reports',(select count(*) from public.dataset_flags where dataset_id=p_dataset_id),
      'audits',(select count(*) from audit.dataset_human_reviews where dataset_id=p_dataset_id and check_key='dataset_evaluation')
        +(select count(*) from audit.legacy_decisions where dataset_id=p_dataset_id),
      'publications',(select count(*) from public.jt_data_publication_datasets where dataset_id=p_dataset_id)),
    'correction_total',(select count(*) from public.v2_geometry_corrections where dataset_id=p_dataset_id)
  ) into result;
  return result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.factory_north_star(p_include_team boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
 SET jit TO 'off'
AS $function$
declare result jsonb; run_since timestamptz; download_since timestamptz; week_start timestamptz; month_start timestamptz;
begin
 if not public.can_operate() then raise exception 'Factory operator permission required' using errcode='42501'; end if;
 if p_include_team is null then raise exception 'Invalid Factory team filter' using errcode='22023'; end if;
 -- First results are observable from the first retained processor run (or measurement).
 select least(started_at,public.factory_run_evidence_since()) into run_since from public.factory_measurement_epoch;
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
 ), results as materialized (
  -- Uploads before retained processor runs never count: their first result is unknown.
  select u.*,e.uploaded_at>=run_since as observable,
   case when e.uploaded_at>=run_since then e.first_result_at end as result_at
  from uploads u left join public.factory_outcome_evidence e on e.dataset_id=u.dataset_id
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
  select a.decided_at as audited_at from audit.evaluation_decisions a join public.v2_datasets d on d.id=a.dataset_id
  where a.decision='keep' and a.decided_at>=week_start and a.decided_at<=now()
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
  -- One entry per accepted request; a bundle is reuse if any dataset is someone else's.
  select r.request_id,min(r.requested_at) as requested_at,bool_or(r.user_id is distinct from d.user_id) as reuse
  from public.dataset_download_requests r join public.v2_datasets d on d.id=r.dataset_id
  where r.requested_at>=week_start and r.requested_at<=now()
   and not exists(select 1 from team t where t.user_id=r.user_id)
  group by r.request_id
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
   'Complete results count each dataset once, at its first complete result: measured readiness where available, otherwise the first moment processor runs after upload had proven every readiness stage, reconstructed from retained processor logs. Uploads before the first retained processing run are never counted, because their first result is unknown.',
   'Upload times come from direct measurement or upload logs; older datasets fall back to their registration time.',
   'Never reached within 7 days groups uploads by upload week and includes late results. The stage breakdown shows where those uploads stand now, not where they first failed.',
   'Reference data counts datasets whose audit evaluation decision is keep (a reviewer''s, the old audit''s or the check''s), by the date of that decision. Excluded datasets are not counted.',
   'Downloads are accepted download requests, not completed transfers. Reuse means someone other than the dataset owner. Coverage starts with the first request the API recorded; earlier weeks are unknown, and that first week is a lower bound. Older request logs were written before access checks and are not used.',
   'Activation and retention use monthly cohorts and only count elapsed windows. A return upload must be on a later day, so one batch is one visit. Deleted datasets and accounts are absent.'
  )) into result;
 return result;
end;
$function$;

-- ---------------------------------------------------------------------------
-- The legacy audits become read-only history
-- ---------------------------------------------------------------------------

drop trigger guard_dataset_audit_lease on public.dataset_audit_legacy;
drop trigger record_audit_date_decision on public.dataset_audit_legacy;
drop policy "Dataset audit write for auditors" on public.dataset_audit_legacy;
revoke insert, update, delete, truncate on public.dataset_audit_legacy, public.dataset_audit
	from anon, authenticated, service_role;
-- the monitor read its ten audit columns here; it has no audit reader any more
revoke all on public.dataset_audit_legacy from deadtrees_operator_status;
drop policy operator_monitoring_read on public.dataset_audit_legacy;
comment on table public.dataset_audit_legacy is
	'The saved manual audits before the Audit Review (read-only history; keep or exclude copied into audit.legacy_decisions).';
comment on view public.dataset_audit is
	'Read-only history of the saved manual audits (dataset_audit_legacy).';

drop view public.audit_review_queue;

-- ---------------------------------------------------------------------------
-- No audit suggestions: the checks report their outputs in the audit schema
-- ---------------------------------------------------------------------------

-- Nothing reads them any more and the processor writes none.
drop table public.dataset_audit_suggestions;
drop function public.track_audit_suggestion_change();

-- ---------------------------------------------------------------------------
-- No acquisition date decisions: AerialStamp's output only says replace yes or no
-- ---------------------------------------------------------------------------

drop trigger supersede_contradicted_date_decision on public.v2_acquisition_date_estimates;
drop function public.supersede_contradicted_date_decision();
drop function public.record_audit_date_decision();
drop function public.record_automatic_acquisition_date_decision(bigint);
drop function public.record_acquisition_date_decision(bigint, boolean, boolean, text, uuid);
drop function public.supersede_acquisition_date_decisions_before(timestamptz);

-- A hand edit still makes the date a reported one; the decision rows stay as they are.
create or replace function public.reset_edited_acquisition_date()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
	if (new.aquisition_year, new.aquisition_month, new.aquisition_day)
		is distinct from (old.aquisition_year, old.aquisition_month, old.aquisition_day) then
		new.aquisition_date_source := 'reported';
		new.aquisition_date_decision_id := null;
	end if;
	return new;
end;
$$;
drop function public.supersede_acquisition_date_decision(bigint, text);

revoke insert, update, delete, truncate on public.acquisition_date_decisions from anon, authenticated;
comment on table public.acquisition_date_decisions is
	'Acquisition date decisions of the saved audits and the old date check (read-only history).';

-- ---------------------------------------------------------------------------
-- Edits & flags leave the audit
-- ---------------------------------------------------------------------------

drop trigger validate_flag_audit_lease on public.dataset_flags;
drop trigger validate_correction_audit_lease on public.v2_geometry_corrections;

notify pgrst, 'reload schema';
