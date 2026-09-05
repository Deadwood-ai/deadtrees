-- Metadata across private and public workflows for the dedicated SQL monitor.
-- Existing login credentials and app-role policies are unchanged. New installs
-- get NOLOGIN; provisioning a production login is a separate operation.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'deadtrees_operator_status') THEN
    CREATE ROLE deadtrees_operator_status NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO deadtrees_operator_status;

-- Explicit columns prevent future payload/geometry columns inheriting access.
-- Existing grants on logs/queue/statuses are not revoked by this migration.
GRANT SELECT (id, created_at, data_access, platform, archived)
  ON public.v2_datasets TO deadtrees_operator_status;

GRANT SELECT (dataset_id, created_at, updated_at, current_status, has_error, is_upload_done,
  is_ortho_done, is_cog_done, is_thumbnail_done, is_metadata_done, is_deadwood_done,
  is_forest_cover_done, is_combined_model_done, is_odm_done)
  ON public.v2_statuses TO deadtrees_operator_status;

GRANT SELECT (id, dataset_id, created_at, is_processing, priority)
  ON public.v2_queue TO deadtrees_operator_status;

GRANT SELECT (id, dataset_id, created_at, level)
  ON public.v2_logs TO deadtrees_operator_status;

GRANT SELECT (dataset_id, created_at, version, processing_runtime)
  ON public.v2_metadata TO deadtrees_operator_status;

GRANT SELECT (dataset_id, created_at, version, raw_image_count, raw_image_size_mb)
  ON public.v2_raw_images TO deadtrees_operator_status;

GRANT SELECT (dataset_id, created_at, version, ortho_file_size, ortho_upload_runtime)
  ON public.v2_orthos TO deadtrees_operator_status;

GRANT SELECT (dataset_id, created_at, version, ortho_file_size, ortho_processing_runtime)
  ON public.v2_orthos_processed TO deadtrees_operator_status;

GRANT SELECT (dataset_id, created_at, version, cog_file_size, cog_processing_runtime)
  ON public.v2_cogs TO deadtrees_operator_status;

GRANT SELECT (dataset_id, created_at, version, thumbnail_file_size, thumbnail_processing_runtime)
  ON public.v2_thumbnails TO deadtrees_operator_status;

GRANT SELECT (id, label_data, created_at, updated_at)
  ON public.v2_model_preferences TO deadtrees_operator_status;

GRANT SELECT (id, created_at, status, doi, freidata_record_id, notified_at, published_at)
  ON public.data_publication TO deadtrees_operator_status;

GRANT SELECT (publication_id, dataset_id)
  ON public.jt_data_publication_datasets TO deadtrees_operator_status;

GRANT SELECT (dataset_id, audit_date, is_georeferenced, has_valid_acquisition_date,
  has_valid_phenology, deadwood_quality, forest_cover_quality, aoi_done,
  has_cog_issue, has_thumbnail_issue)
  ON public.dataset_audit TO deadtrees_operator_status;

GRANT SELECT (id, dataset_id, status, is_ortho_mosaic_issue, is_prediction_issue, created_at,
  updated_at)
  ON public.dataset_flags TO deadtrees_operator_status;

GRANT SELECT (id, flag_id, old_status, new_status, changed_at)
  ON public.dataset_flag_status_history TO deadtrees_operator_status;

GRANT SELECT (id, slug, kind, is_active, created_at, updated_at)
  ON public.prepackaged_dataset_definitions TO deadtrees_operator_status;

GRANT SELECT (id, definition_id, created_at, built_at, published_at, version, status, size_bytes,
  dataset_count, artifact_count)
  ON public.prepackaged_dataset_versions TO deadtrees_operator_status;

GRANT SELECT (id, created_at, expires_at, last_validated_at, revoked_at, version_id,
  validation_count)
  ON public.prepackaged_dataset_download_grants TO deadtrees_operator_status;

GRANT SELECT (id, created_at, dataset_id)
  ON public.reference_datasets TO deadtrees_operator_status;

GRANT SELECT (id, dataset_id, deadwood_validated, forest_cover_validated, created_at, updated_at)
  ON public.reference_patches TO deadtrees_operator_status;

GRANT SELECT (id, queue_task_id, dataset_id, event_type, task_types, status, delivery_attempts,
  provider, next_attempt_at, created_at, updated_at, sent_at)
  ON public.processing_notification_events TO deadtrees_operator_status;

GRANT SELECT (processing_emails_enabled, created_at, updated_at)
  ON public.user_notification_preferences TO deadtrees_operator_status;

GRANT SELECT (id, created_at)
  ON public.priwa_projects TO deadtrees_operator_status;

GRANT SELECT (project_id, dataset_id, flight_type, reviewed_at)
  ON public.priwa_project_flights TO deadtrees_operator_status;

GRANT SELECT (id, project_id, origin, created_at, updated_at)
  ON public.priwa_befallsgruppen TO deadtrees_operator_status;

GRANT SELECT (group_id, dataset_id, source, created_at)
  ON public.priwa_befallsgruppe_flights TO deadtrees_operator_status;

GRANT SELECT (id, project_id, created_at, updated_at, deleted_at)
  ON public.priwa_kaeferbaeume TO deadtrees_operator_status;

GRANT SELECT (id, project_id, source_date, feature_count, imported_at)
  ON public.priwa_warnkarte_versions TO deadtrees_operator_status;

GRANT SELECT (id, project_id, version_id, published_at)
  ON public.priwa_warnkarte_publications TO deadtrees_operator_status;

GRANT SELECT (id, project_id, version_id, action, acted_at)
  ON public.priwa_warnkarte_archive_events TO deadtrees_operator_status;

GRANT SELECT (id, condition, tree_type_group, created_at)
  ON public.public_tree_observations TO deadtrees_operator_status;

GRANT SELECT (id, created_at, dataset_id)
  ON public.v2_search_queries TO deadtrees_operator_status;

-- Role-specific SELECT only. No membership in app roles, write privileges,
-- sequence privileges, function grants, or default privileges are added.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'v2_datasets',
    'v2_statuses',
    'v2_queue',
    'v2_logs',
    'v2_metadata',
    'v2_raw_images',
    'v2_orthos',
    'v2_orthos_processed',
    'v2_cogs',
    'v2_thumbnails',
    'v2_model_preferences',
    'data_publication',
    'jt_data_publication_datasets',
    'dataset_audit',
    'dataset_flags',
    'dataset_flag_status_history',
    'prepackaged_dataset_definitions',
    'prepackaged_dataset_versions',
    'prepackaged_dataset_download_grants',
    'reference_datasets',
    'reference_patches',
    'processing_notification_events',
    'user_notification_preferences',
    'priwa_projects',
    'priwa_project_flights',
    'priwa_befallsgruppen',
    'priwa_befallsgruppe_flights',
    'priwa_kaeferbaeume',
    'priwa_warnkarte_versions',
    'priwa_warnkarte_publications',
    'priwa_warnkarte_archive_events',
    'public_tree_observations',
    'v2_search_queries'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY operator_monitoring_read ON public.%I FOR SELECT TO deadtrees_operator_status USING (true)',
      table_name
    );
  END LOOP;
END
$$;
