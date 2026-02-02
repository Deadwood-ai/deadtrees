-- Add archived column to v2_datasets for soft delete functionality
-- Users can archive their datasets to hide them from their profile without actually deleting data

-- 1. Add the archived column to v2_datasets
ALTER TABLE "public"."v2_datasets" 
ADD COLUMN "archived" boolean NOT NULL DEFAULT false;

-- 2. Add index for efficient filtering on archived
CREATE INDEX "v2_datasets_archived_idx" ON "public"."v2_datasets" USING btree ("archived");

-- 3. Update v2_full_dataset_view to include archived column and exclude archived datasets from regular users
-- Note: The view already filters by data_access, we add archived filtering
DROP VIEW IF EXISTS "public"."v2_full_dataset_view_public";
DROP VIEW IF EXISTS "public"."v2_full_dataset_view";

CREATE OR REPLACE VIEW "public"."v2_full_dataset_view" AS
WITH ds AS (
    SELECT 
        v2_datasets.id,
        v2_datasets.user_id,
        v2_datasets.created_at,
        v2_datasets.file_name,
        v2_datasets.license,
        v2_datasets.platform,
        v2_datasets.project_id,
        v2_datasets.authors,
        v2_datasets.aquisition_year,
        v2_datasets.aquisition_month,
        v2_datasets.aquisition_day,
        v2_datasets.additional_information,
        v2_datasets.data_access,
        v2_datasets.citation_doi,
        v2_datasets.archived
    FROM v2_datasets
    WHERE (
        (v2_datasets.data_access <> 'private'::access) 
        OR (auth.uid() = v2_datasets.user_id) 
        OR can_view_all_private_data()
    )
    -- Exclude archived datasets unless user is the owner
    AND (
        v2_datasets.archived = false 
        OR auth.uid() = v2_datasets.user_id
    )
), ortho AS (
    SELECT 
        v2_orthos.dataset_id,
        v2_orthos.ortho_file_name,
        v2_orthos.ortho_file_size,
        v2_orthos.bbox,
        v2_orthos.sha256,
        v2_orthos.ortho_upload_runtime
    FROM v2_orthos
), status AS (
    SELECT 
        v2_statuses.dataset_id,
        v2_statuses.current_status,
        v2_statuses.is_upload_done,
        v2_statuses.is_ortho_done,
        v2_statuses.is_cog_done,
        v2_statuses.is_thumbnail_done,
        v2_statuses.is_deadwood_done,
        v2_statuses.is_forest_cover_done,
        v2_statuses.is_metadata_done,
        v2_statuses.is_odm_done,
        (EXISTS (
            SELECT 1 FROM dataset_audit da WHERE da.dataset_id = v2_statuses.dataset_id
        )) AS is_audited,
        v2_statuses.has_error,
        v2_statuses.error_message,
        v2_statuses.has_ml_tiles,
        v2_statuses.ml_tiles_completed_at
    FROM v2_statuses
), extra AS (
    SELECT 
        ds_1.id AS dataset_id,
        cog.cog_file_name,
        cog.cog_path,
        cog.cog_file_size,
        thumb.thumbnail_file_name,
        thumb.thumbnail_path,
        (meta.metadata ->> 'gadm'::text) AS admin_metadata,
        (meta.metadata ->> 'biome'::text) AS biome_metadata
    FROM v2_datasets ds_1
    LEFT JOIN v2_cogs cog ON cog.dataset_id = ds_1.id
    LEFT JOIN v2_thumbnails thumb ON thumb.dataset_id = ds_1.id
    LEFT JOIN v2_metadata meta ON meta.dataset_id = ds_1.id
    WHERE (
        (ds_1.data_access <> 'private'::access) 
        OR (auth.uid() = ds_1.user_id) 
        OR can_view_all_private_data()
    )
    AND (
        ds_1.archived = false 
        OR auth.uid() = ds_1.user_id
    )
), label_info AS (
    SELECT 
        dataset.id AS dataset_id,
        (EXISTS (
            SELECT 1 FROM v2_labels
            WHERE v2_labels.dataset_id = dataset.id 
            AND v2_labels.label_source = 'visual_interpretation'::"LabelSource" 
            AND v2_labels.label_data = 'deadwood'::"LabelData"
        )) AS has_labels,
        (EXISTS (
            SELECT 1 FROM v2_labels
            WHERE v2_labels.dataset_id = dataset.id 
            AND v2_labels.label_source = 'model_prediction'::"LabelSource" 
            AND v2_labels.label_data = 'deadwood'::"LabelData"
        )) AS has_deadwood_prediction
    FROM v2_datasets dataset
    WHERE (
        (dataset.data_access <> 'private'::access) 
        OR (auth.uid() = dataset.user_id) 
        OR can_view_all_private_data()
    )
    AND (
        dataset.archived = false 
        OR auth.uid() = dataset.user_id
    )
), freidata_doi AS (
    SELECT 
        jt.dataset_id,
        dp.doi AS freidata_doi
    FROM jt_data_publication_datasets jt
    JOIN data_publication dp ON dp.id = jt.publication_id
    WHERE dp.doi IS NOT NULL
), correction_stats AS (
    SELECT 
        gc.dataset_id,
        count(*) FILTER (WHERE gc.review_status = 'pending'::text) AS pending_corrections_count,
        count(*) FILTER (WHERE gc.review_status = 'approved'::text) AS approved_corrections_count,
        count(*) FILTER (WHERE gc.review_status = 'rejected'::text) AS rejected_corrections_count,
        count(*) AS total_corrections_count
    FROM v2_geometry_corrections gc
    GROUP BY gc.dataset_id
)
SELECT 
    ds.id,
    ds.user_id,
    ds.created_at,
    ds.file_name,
    ds.license,
    ds.platform,
    ds.project_id,
    ds.authors,
    ds.aquisition_year,
    ds.aquisition_month,
    ds.aquisition_day,
    ds.additional_information,
    ds.data_access,
    ds.citation_doi,
    ds.archived,
    ortho.ortho_file_name,
    ortho.ortho_file_size,
    ortho.bbox,
    ortho.sha256,
    status.current_status,
    status.is_upload_done,
    status.is_ortho_done,
    status.is_cog_done,
    status.is_thumbnail_done,
    status.is_deadwood_done,
    status.is_forest_cover_done,
    status.is_metadata_done,
    status.is_odm_done,
    status.is_audited,
    status.has_error,
    status.error_message,
    extra.cog_file_name,
    extra.cog_path,
    extra.cog_file_size,
    extra.thumbnail_file_name,
    extra.thumbnail_path,
    ((extra.admin_metadata)::jsonb ->> 'admin_level_1'::text) AS admin_level_1,
    ((extra.admin_metadata)::jsonb ->> 'admin_level_2'::text) AS admin_level_2,
    ((extra.admin_metadata)::jsonb ->> 'admin_level_3'::text) AS admin_level_3,
    ((extra.biome_metadata)::jsonb ->> 'biome_name'::text) AS biome_name,
    label_info.has_labels,
    label_info.has_deadwood_prediction,
    freidata_doi.freidata_doi,
    status.has_ml_tiles,
    status.ml_tiles_completed_at,
    COALESCE(correction_stats.pending_corrections_count, 0::bigint) AS pending_corrections_count,
    COALESCE(correction_stats.approved_corrections_count, 0::bigint) AS approved_corrections_count,
    COALESCE(correction_stats.rejected_corrections_count, 0::bigint) AS rejected_corrections_count,
    COALESCE(correction_stats.total_corrections_count, 0::bigint) AS total_corrections_count
FROM ds
LEFT JOIN ortho ON ortho.dataset_id = ds.id
LEFT JOIN status ON status.dataset_id = ds.id
LEFT JOIN extra ON extra.dataset_id = ds.id
LEFT JOIN label_info ON label_info.dataset_id = ds.id
LEFT JOIN freidata_doi ON freidata_doi.dataset_id = ds.id
LEFT JOIN correction_stats ON correction_stats.dataset_id = ds.id;

-- 4. Recreate v2_full_dataset_view_public with archived filtering
-- This view excludes: private datasets (for non-owners), excluded datasets, and archived datasets
CREATE OR REPLACE VIEW "public"."v2_full_dataset_view_public" AS
SELECT 
    base.id,
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
    base.archived,
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
    base.has_ml_tiles,
    base.ml_tiles_completed_at,
    base.pending_corrections_count,
    base.approved_corrections_count,
    base.rejected_corrections_count,
    base.total_corrections_count,
    audit_data.final_assessment,
    audit_data.deadwood_quality,
    audit_data.forest_cover_quality,
    audit_data.has_major_issue,
    audit_data.audit_date,
    audit_data.audited_by,
    audit_data.audited_by_email,
    CASE
        WHEN audit_data.deadwood_quality IN ('great', 'sentinel_ok') THEN true
        ELSE false
    END AS show_deadwood_predictions,
    CASE
        WHEN audit_data.forest_cover_quality IN ('great', 'sentinel_ok') THEN true
        ELSE false
    END AS show_forest_cover_predictions
FROM v2_full_dataset_view base
LEFT JOIN (
    SELECT 
        da.dataset_id,
        da.final_assessment,
        da.deadwood_quality::text,
        da.forest_cover_quality::text,
        da.has_major_issue,
        da.audit_date,
        da.audited_by,
        au.email AS audited_by_email
    FROM dataset_audit da
    LEFT JOIN auth.users au ON da.audited_by = au.id
) audit_data ON audit_data.dataset_id = base.id
WHERE (
    (audit_data.final_assessment IS NULL) 
    OR (audit_data.final_assessment <> 'exclude_completely'::text)
)
-- Exclude archived datasets from public view (owners can still see in full view)
AND base.archived = false;
