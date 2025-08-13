create or replace view "public"."v2_full_dataset_view_public" as  SELECT base.id,
    base.user_id,
    base.created_at,
    base.file_name,
    base.license,
    base.platform,
    base.project_id,
    base.authors,
    base.aquisition_year,
    base.aquisition_month,
    base.aquisition_day,
    base.additional_information,
    base.data_access,
    base.citation_doi,
    base.ortho_file_name,
    base.ortho_file_size,
    base.bbox,
    base.sha256,
    base.current_status,
    base.is_upload_done,
    base.is_ortho_done,
    base.is_cog_done,
    base.is_thumbnail_done,
    base.is_deadwood_done,
    base.is_forest_cover_done,
    base.is_metadata_done,
    base.is_odm_done,
    base.is_audited,
    base.has_error,
    base.error_message,
    base.cog_file_name,
    base.cog_path,
    base.cog_file_size,
    base.thumbnail_file_name,
    base.thumbnail_path,
    base.admin_level_1,
    base.admin_level_2,
    base.admin_level_3,
    base.biome_name,
    base.has_labels,
    base.has_deadwood_prediction,
    base.freidata_doi,
    audit_data.final_assessment,
    audit_data.deadwood_quality,
    audit_data.forest_cover_quality,
    audit_data.has_major_issue,
    audit_data.audit_date,
    audit_data.audited_by,
    audit_data.audited_by_email,
        CASE
            WHEN (audit_data.deadwood_quality = 'bad'::prediction_quality) THEN false
            WHEN (audit_data.deadwood_quality = ANY (ARRAY['great'::prediction_quality, 'sentinel_ok'::prediction_quality])) THEN true
            WHEN ((audit_data.deadwood_quality IS NULL) AND (base.is_audited = true)) THEN false
            ELSE true
        END AS show_deadwood_predictions,
        CASE
            WHEN (audit_data.forest_cover_quality = 'bad'::prediction_quality) THEN false
            WHEN (audit_data.forest_cover_quality = ANY (ARRAY['great'::prediction_quality, 'sentinel_ok'::prediction_quality])) THEN true
            WHEN ((audit_data.forest_cover_quality IS NULL) AND (base.is_audited = true)) THEN false
            ELSE true
        END AS show_forest_cover_predictions
   FROM (v2_full_dataset_view base
     LEFT JOIN ( SELECT da.dataset_id,
            da.final_assessment,
            da.deadwood_quality,
            da.forest_cover_quality,
            da.has_major_issue,
            da.audit_date,
            da.audited_by,
            au.email AS audited_by_email
           FROM (dataset_audit da
             LEFT JOIN auth.users au ON ((da.audited_by = au.id)))) audit_data ON ((audit_data.dataset_id = base.id)))
  WHERE ((audit_data.final_assessment IS NULL) OR (audit_data.final_assessment <> 'exclude_completely'::text));



