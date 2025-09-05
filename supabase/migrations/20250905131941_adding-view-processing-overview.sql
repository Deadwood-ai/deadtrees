CREATE INDEX idx_v2_logs_dataset_created ON public.v2_logs USING btree (dataset_id, created_at DESC);

create or replace view "public"."v2_processing_overview" as  SELECT DISTINCT ON (d.id) d.id AS dataset_id,
    d.file_name,
    d.created_at AS dataset_created_at,
        CASE
            WHEN ((COALESCE(ri.raw_image_count, 0) > 0) OR s.is_odm_done) THEN 'odm'::text
            ELSE 'geotiff'::text
        END AS processing_source,
        CASE
            WHEN ((s.current_status <> 'idle'::v2_status) AND (s.has_error IS DISTINCT FROM true)) THEN 'PROCESSING'::text
            WHEN (EXISTS ( SELECT 1
               FROM v2_queue q
              WHERE (q.dataset_id = d.id))) THEN 'QUEUED'::text
            WHEN s.has_error THEN 'FAILED'::text
            ELSE 'COMPLETED'::text
        END AS processing_status,
    s.current_status,
    s.has_error,
    s.error_message,
    (EXTRACT(epoch FROM (now() - s.updated_at)) / (3600)::numeric) AS hours_since_status_update,
        CASE
            WHEN (s.current_status <> 'idle'::v2_status) THEN (EXTRACT(epoch FROM (now() - s.updated_at)) / (3600)::numeric)
            ELSE NULL::numeric
        END AS hours_in_current_status,
    s.updated_at AS status_last_updated,
    (EXISTS ( SELECT 1
           FROM v2_queue q
          WHERE (q.dataset_id = d.id))) AS is_in_queue,
    ( SELECT min(q.created_at) AS min
           FROM v2_queue q
          WHERE (q.dataset_id = d.id)) AS queued_at,
    ( SELECT min(q.priority) AS min
           FROM v2_queue q
          WHERE (q.dataset_id = d.id)) AS queue_priority,
    au.email AS user_email,
    ui.organisation,
    s.is_upload_done,
    s.is_ortho_done,
    s.is_cog_done,
    s.is_thumbnail_done,
    s.is_deadwood_done,
    s.is_forest_cover_done,
    s.is_metadata_done,
    s.is_odm_done,
    s.is_audited,
    ( SELECT count(*) AS count
           FROM v2_aois a
          WHERE (a.dataset_id = d.id)) AS aoi_count,
    ( SELECT count(dg.id) AS count
           FROM (v2_labels l
             LEFT JOIN v2_deadwood_geometries dg ON ((dg.label_id = l.id)))
          WHERE (l.dataset_id = d.id)) AS deadwood_geometry_count,
    ( SELECT count(fg.id) AS count
           FROM (v2_labels l
             LEFT JOIN v2_forest_cover_geometries fg ON ((fg.label_id = l.id)))
          WHERE (l.dataset_id = d.id)) AS forest_cover_geometry_count,
    ri.raw_images_path,
    ri.raw_image_count,
    ri.raw_image_size_mb,
    o.ortho_file_size,
    c.cog_file_size,
    COALESCE((((o.ortho_info -> 'Profile'::text) ->> 'Width'::text))::integer, ((o.ortho_info ->> 'Width'::text))::integer) AS ortho_width,
    COALESCE((((o.ortho_info -> 'Profile'::text) ->> 'Height'::text))::integer, ((o.ortho_info ->> 'Height'::text))::integer) AS ortho_height,
    ((o.ortho_info -> 'GEO'::text) ->> 'CRS'::text) AS ortho_crs,
    ((c.cog_info -> 'GEO'::text) ->> 'CRS'::text) AS cog_crs,
    jsonb_strip_nulls((COALESCE(ri.camera_metadata, '{}'::jsonb) || jsonb_build_object('has_rtk_data', ri.has_rtk_data, 'rtk_precision_cm', ri.rtk_precision_cm, 'rtk_quality_indicator', ri.rtk_quality_indicator, 'rtk_file_count', ri.rtk_file_count))) AS raw_images_metadata,
    o.ortho_info AS ortho_metadata,
    c.cog_info AS cog_metadata,
    ( SELECT string_agg(((((((recent_logs.level || '|'::text) || COALESCE(recent_logs.category, 'general'::text)) || '|'::text) || to_char(recent_logs.created_at, 'MM-DD HH24:MI'::text)) || '|'::text) || "substring"(recent_logs.message, 1, 100)), chr(10) ORDER BY recent_logs.created_at DESC) AS string_agg
           FROM ( SELECT v2_logs.level,
                    v2_logs.category,
                    v2_logs.message,
                    v2_logs.created_at
                   FROM v2_logs
                  WHERE (v2_logs.dataset_id = d.id)
                  ORDER BY v2_logs.created_at DESC
                 LIMIT 20) recent_logs) AS last_20_logs
   FROM ((((((v2_datasets d
     LEFT JOIN v2_statuses s ON ((s.dataset_id = d.id)))
     LEFT JOIN auth.users au ON ((au.id = d.user_id)))
     LEFT JOIN user_info ui ON ((ui."user" = d.user_id)))
     LEFT JOIN LATERAL ( SELECT o_1.dataset_id,
            o_1.ortho_file_name,
            o_1.version,
            o_1.created_at,
            o_1.bbox,
            o_1.sha256,
            o_1.ortho_upload_runtime,
            o_1.ortho_file_size,
            o_1.ortho_info
           FROM v2_orthos o_1
          WHERE (o_1.dataset_id = d.id)
          ORDER BY o_1.created_at DESC, o_1.version DESC
         LIMIT 1) o ON (true))
     LEFT JOIN LATERAL ( SELECT c_1.dataset_id,
            c_1.cog_file_name,
            c_1.version,
            c_1.created_at,
            c_1.cog_info,
            c_1.cog_processing_runtime,
            c_1.cog_path,
            c_1.cog_file_size
           FROM v2_cogs c_1
          WHERE (c_1.dataset_id = d.id)
          ORDER BY c_1.created_at DESC, c_1.version DESC
         LIMIT 1) c ON (true))
     LEFT JOIN LATERAL ( SELECT ri_1.dataset_id,
            ri_1.raw_image_count,
            ri_1.raw_image_size_mb,
            ri_1.raw_images_path,
            ri_1.camera_metadata,
            ri_1.has_rtk_data,
            ri_1.rtk_precision_cm,
            ri_1.rtk_quality_indicator,
            ri_1.rtk_file_count,
            ri_1.version,
            ri_1.created_at
           FROM v2_raw_images ri_1
          WHERE (ri_1.dataset_id = d.id)
          ORDER BY ri_1.created_at DESC, ri_1.version DESC
         LIMIT 1) ri ON (true))
  ORDER BY d.id DESC, COALESCE(s.updated_at, d.created_at) DESC
 LIMIT 100;



