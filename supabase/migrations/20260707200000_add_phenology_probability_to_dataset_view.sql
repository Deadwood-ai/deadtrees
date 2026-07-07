-- Move the "phenology probability" computation from the browser into Postgres.
--
-- Previously the audit page downloaded the full `metadata` JSONB for up to 500
-- datasets just to read one value out of the 366-element `phenology_curve` per
-- dataset (a multi-MB response behind a 3.6k-char URL that intermittently 502'd
-- at the nginx->kong hop). This computes the same value server-side and exposes
-- it as `v2_full_dataset_view.phenology_probability`, so it rides along with the
-- dataset list the audit page already fetches (`select *`) — no extra request.
--
-- The logic mirrors the former client-side getPhenologyProbability():
--   centerDay = day-of-year of the acquisition date
--               (mid-month if the day is unknown, day 183 if only the year is),
--   probability = clamp(curve[centerDay - 1] / 255, 0, 1).

CREATE OR REPLACE FUNCTION public.phenology_probability_at(
  curve jsonb,
  y smallint,
  m smallint,
  d smallint
) RETURNS real
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN curve IS NULL
      OR jsonb_typeof(curve) <> 'array'
      OR jsonb_array_length(curve) = 0
      OR y IS NULL OR y < 1 OR y > 9999
      THEN NULL::real
    ELSE GREATEST(0::real, LEAST(1::real,
      NULLIF(curve ->> LEAST(GREATEST(center_day - 1, 0), jsonb_array_length(curve) - 1), '')::real / 255.0))
  END
  FROM (
    SELECT CASE
      -- Full date known: exact day-of-year (day capped to the month length).
      WHEN m BETWEEN 1 AND 12 AND d BETWEEN 1 AND 31
        THEN EXTRACT(DOY FROM make_date(y::int, m::int, 1))::int + LEAST(d::int, dim) - 1
      -- Month known, day unknown: middle of the month.
      WHEN m BETWEEN 1 AND 12
        THEN (2 * EXTRACT(DOY FROM make_date(y::int, m::int, 1))::int + dim - 1) / 2
      -- Only the year is known: approximate middle of the year.
      ELSE 183
    END AS center_day
    FROM (
      SELECT CASE
        WHEN m BETWEEN 1 AND 12
          THEN EXTRACT(DAY FROM (make_date(y::int, m::int, 1) + interval '1 month - 1 day'))::int
        ELSE 30
      END AS dim
    ) days_in_month
  ) center
$$;

GRANT EXECUTE ON FUNCTION public.phenology_probability_at(jsonb, smallint, smallint, smallint)
  TO anon, authenticated, service_role;

-- Re-create the view with the new column appended at the end. CREATE OR REPLACE
-- keeps all existing columns/order intact and only adds `phenology_probability`,
-- so dependents and grants are preserved. `v2_full_dataset_view_public` selects
-- explicit base columns and does NOT reference the new column, so the public map
-- path is unaffected and pays none of the compute cost.
CREATE OR REPLACE VIEW public.v2_full_dataset_view AS
 WITH ds AS (
         SELECT v2_datasets.id,
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
          WHERE (v2_datasets.data_access <> 'private'::access OR auth.uid() = v2_datasets.user_id OR can_view_all_private_data()) AND (v2_datasets.archived = false OR auth.uid() = v2_datasets.user_id)
        ), ortho AS (
         SELECT v2_orthos.dataset_id,
            v2_orthos.ortho_file_name,
            v2_orthos.ortho_file_size,
            v2_orthos.bbox,
            v2_orthos.sha256,
            v2_orthos.ortho_upload_runtime
           FROM v2_orthos
        ), status AS (
         SELECT v2_statuses.dataset_id,
            v2_statuses.current_status,
            v2_statuses.is_upload_done,
            v2_statuses.is_ortho_done,
            v2_statuses.is_cog_done,
            v2_statuses.is_thumbnail_done,
            v2_statuses.is_deadwood_done,
            v2_statuses.is_forest_cover_done,
            v2_statuses.is_metadata_done,
            v2_statuses.is_odm_done,
            (EXISTS ( SELECT 1
                   FROM dataset_audit da
                  WHERE da.dataset_id = v2_statuses.dataset_id)) AS is_audited,
            v2_statuses.has_error,
            v2_statuses.error_message,
            v2_statuses.has_ml_tiles,
            v2_statuses.ml_tiles_completed_at,
            v2_statuses.is_combined_model_done,
            v2_statuses.is_aoi_done,
            v2_statuses.is_aoi_required
           FROM v2_statuses
        ), extra AS (
         SELECT ds_1.id AS dataset_id,
            cog.cog_file_name,
            cog.cog_path,
            cog.cog_file_size,
            thumb.thumbnail_file_name,
            thumb.thumbnail_path,
            meta.metadata ->> 'gadm'::text AS admin_metadata,
            meta.metadata ->> 'biome'::text AS biome_metadata,
            public.phenology_probability_at(meta.metadata -> 'phenology'::text -> 'phenology_curve'::text, ds_1.aquisition_year, ds_1.aquisition_month, ds_1.aquisition_day) AS phenology_probability
           FROM v2_datasets ds_1
             LEFT JOIN v2_cogs cog ON cog.dataset_id = ds_1.id
             LEFT JOIN v2_thumbnails thumb ON thumb.dataset_id = ds_1.id
             LEFT JOIN v2_metadata meta ON meta.dataset_id = ds_1.id
          WHERE (ds_1.data_access <> 'private'::access OR auth.uid() = ds_1.user_id OR can_view_all_private_data()) AND (ds_1.archived = false OR auth.uid() = ds_1.user_id)
        ), label_info AS (
         SELECT dataset.id AS dataset_id,
            (EXISTS ( SELECT 1
                   FROM v2_labels
                  WHERE v2_labels.dataset_id = dataset.id AND v2_labels.label_source = 'visual_interpretation'::"LabelSource" AND v2_labels.label_data = 'deadwood'::"LabelData")) AS has_labels,
            (EXISTS ( SELECT 1
                   FROM v2_labels
                  WHERE v2_labels.dataset_id = dataset.id AND v2_labels.label_source = 'model_prediction'::"LabelSource" AND v2_labels.label_data = 'deadwood'::"LabelData")) AS has_deadwood_prediction
           FROM v2_datasets dataset
          WHERE (dataset.data_access <> 'private'::access OR auth.uid() = dataset.user_id OR can_view_all_private_data()) AND (dataset.archived = false OR auth.uid() = dataset.user_id)
        ), freidata_doi AS (
         SELECT jt.dataset_id,
            dp.doi AS freidata_doi
           FROM jt_data_publication_datasets jt
             JOIN data_publication dp ON dp.id = jt.publication_id
          WHERE dp.doi IS NOT NULL
        ), correction_stats AS (
         SELECT gc.dataset_id,
            count(*) FILTER (WHERE gc.review_status = 'pending'::text) AS pending_corrections_count,
            count(*) FILTER (WHERE gc.review_status = 'approved'::text) AS approved_corrections_count,
            count(*) FILTER (WHERE gc.review_status = 'rejected'::text) AS rejected_corrections_count,
            count(*) AS total_corrections_count
           FROM v2_geometry_corrections gc
          GROUP BY gc.dataset_id
        )
 SELECT ds.id,
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
    extra.admin_metadata::jsonb ->> 'admin_level_1'::text AS admin_level_1,
    extra.admin_metadata::jsonb ->> 'admin_level_2'::text AS admin_level_2,
    extra.admin_metadata::jsonb ->> 'admin_level_3'::text AS admin_level_3,
    extra.biome_metadata::jsonb ->> 'biome_name'::text AS biome_name,
    label_info.has_labels,
    label_info.has_deadwood_prediction,
    freidata_doi.freidata_doi,
    status.has_ml_tiles,
    status.ml_tiles_completed_at,
    COALESCE(correction_stats.pending_corrections_count, 0::bigint) AS pending_corrections_count,
    COALESCE(correction_stats.approved_corrections_count, 0::bigint) AS approved_corrections_count,
    COALESCE(correction_stats.rejected_corrections_count, 0::bigint) AS rejected_corrections_count,
    COALESCE(correction_stats.total_corrections_count, 0::bigint) AS total_corrections_count,
    status.is_combined_model_done,
    status.is_aoi_done,
    status.is_aoi_required,
    extra.phenology_probability
   FROM ds
     LEFT JOIN ortho ON ortho.dataset_id = ds.id
     LEFT JOIN status ON status.dataset_id = ds.id
     LEFT JOIN extra ON extra.dataset_id = ds.id
     LEFT JOIN label_info ON label_info.dataset_id = ds.id
     LEFT JOIN freidata_doi ON freidata_doi.dataset_id = ds.id
     LEFT JOIN correction_stats ON correction_stats.dataset_id = ds.id;
