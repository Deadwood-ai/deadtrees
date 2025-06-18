drop view if exists "public"."dataset_audit_user_info";

create or replace view "public"."dataset_audit_user_info" as  SELECT da.dataset_id,
    da.audit_date,
    da.is_georeferenced,
    da.has_valid_acquisition_date,
    da.acquisition_date_notes,
    da.has_valid_phenology,
    da.phenology_notes,
    da.deadwood_quality,
    da.deadwood_notes,
    da.forest_cover_quality,
    da.forest_cover_notes,
    da.aoi_done,
    da.has_cog_issue,
    da.cog_issue_notes,
    da.has_thumbnail_issue,
    da.thumbnail_issue_notes,
    da.audited_by,
    da.notes,
    da.has_major_issue,
    da.final_assessment,
    au.email AS audited_by_email,
    uu.email AS uploaded_by_email
   FROM (((dataset_audit da
     LEFT JOIN auth.users au ON ((da.audited_by = au.id)))
     LEFT JOIN v2_datasets d ON ((da.dataset_id = d.id)))
     LEFT JOIN auth.users uu ON ((d.user_id = uu.id)));



