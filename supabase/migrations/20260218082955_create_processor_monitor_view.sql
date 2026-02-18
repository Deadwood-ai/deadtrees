create or replace view "public"."v2_processor_monitor" as  SELECT l.created_at,
    l.level,
    l.category,
    l.message,
    l.dataset_id,
    d.file_name,
    au.email AS user_email,
    s.current_status,
    s.has_error
   FROM (((v2_logs l
     LEFT JOIN v2_datasets d ON ((l.dataset_id = d.id)))
     LEFT JOIN auth.users au ON ((d.user_id = au.id)))
     LEFT JOIN v2_statuses s ON ((l.dataset_id = s.dataset_id)))
  WHERE (l.created_at > (now() - '10 days'::interval))
  ORDER BY l.created_at DESC;



