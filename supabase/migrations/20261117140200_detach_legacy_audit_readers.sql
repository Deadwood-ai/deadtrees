-- Audit Review: the saved legacy audits are detached from every workflow (1 of 2, readers).
--
-- dataset_audit_legacy (view dataset_audit) stays as read-only history, read only by the
-- legacy list page's RPCs (get_dataset_audits_with_emails, get_dataset_audit_with_emails).
-- Its readers move to the audit schema:
-- - The public surface hides a dataset only when its evaluation decision is exclude
--   (audit.is_dataset_excluded, audit.excluded_dataset_ids). Search, the archive, PRIWA
--   flights, labels, AOIs and the correction RPCs follow through the helpers they call.
-- - Predictions are never hidden because of the audit: the dataset views lose
--   show_deadwood_predictions, show_forest_cover_predictions and the legacy fields and
--   expose audit_decision (ok, exclude) to audit readers and the dataset's owner.
-- - The processing overview's is_audited is the decision.
-- The next migration moves the export view and the factory, and stops the writes.
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- The decision for the dataset views
-- ---------------------------------------------------------------------------

-- Audit readers see every evaluation decision, everyone else the decisions on their own
-- datasets. Owner-run, so callers without access to the audit schema can join it.
create function internal.audit_decisions()
returns table (dataset_id bigint, decision text)
language sql stable security definer set search_path = ''
as $$
	select e.dataset_id, e.decision
	from audit.evaluation_decisions e
	where e.decision is not null and (select internal.can_read_audit_checks())
	union all
	select own.id, e.decision
	from public.v2_datasets own
	cross join lateral (select d.decision from audit.evaluation_decisions d where d.dataset_id = own.id) e
	where own.user_id = (select auth.uid()) and e.decision is not null
		and not (select internal.can_read_audit_checks());
$$;
revoke all on function internal.audit_decisions() from public;
grant execute on function internal.audit_decisions() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Exclusion from the public surface: the evaluation decision is exclude
-- ---------------------------------------------------------------------------

create or replace function internal.is_dataset_excluded_from_public_surface(p_dataset_id bigint)
returns boolean
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
	select exists (
		select 1
		from public.v2_datasets dataset
		where dataset.id = p_dataset_id
			and (
				dataset.data_access <> 'private'::access
				or auth.uid() = dataset.user_id
				or public.can_view_all_private_data()
			)
			and (
				dataset.archived = false
				or auth.uid() = dataset.user_id
			)
			and dataset.id not in (select internal.granted_dataset_ids())
			and audit.is_dataset_excluded(dataset.id)
	);
$function$;

create or replace function internal.public_surface_excluded_dataset_ids()
returns setof bigint
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
	select dataset.id
	from public.v2_datasets dataset
	where dataset.id in (select audit.excluded_dataset_ids())
		and (
			dataset.data_access <> 'private'::access
			or dataset.user_id = (select auth.uid())
			or (select public.can_view_all_private_data())
		)
		and (
			dataset.archived = false
			or dataset.user_id = (select auth.uid())
		)
		and dataset.id not in (select internal.granted_dataset_ids());
$function$;

create or replace function internal.search_visible_dataset_ids()
returns bigint[]
language plpgsql stable security definer
set search_path to 'public'
as $function$
declare
  uid uuid := auth.uid();
  sees_all boolean := public.can_view_all_private_data()
    or coalesce((auth.jwt() ->> 'email') = 'processor@deadtrees.earth', false);
  granted bigint[] := array(select internal.granted_dataset_ids());
  excluded bigint[] := array(select audit.excluded_dataset_ids());
begin
  return coalesce((
    select array_agg(d.id)
    from public.v2_datasets d
    where exists (
        select 1 from public.v2_statuses s
        where s.dataset_id = d.id and s.is_embeddings_done
      )
      and (d.data_access <> 'private'::access or d.user_id = uid or sees_all or d.id = any (granted))
      and (d.archived = false or d.user_id = uid)
      and (d.user_id = uid or sees_all or d.id = any (granted) or d.id <> all (excluded))
  ), '{}');
end;
$function$;

create or replace function internal.priwa_project_flight_ids(p_project_id uuid)
returns setof bigint
language sql stable security definer
set search_path to ''
as $function$
	select dataset.id
	from public.v2_datasets dataset
	join public.priwa_project_memberships uploader
		on uploader.project_id = p_project_id
		and uploader.user_id = dataset.user_id
		and uploader.contributes_flights
	join public.v2_statuses status on status.dataset_id = dataset.id and status.is_cog_done
	join public.v2_cogs cog on cog.dataset_id = dataset.id and cog.cog_path is not null
	where dataset.platform = 'drone'
		and not dataset.archived
		and not (dataset.id in (select audit.excluded_dataset_ids()))
		and (
			dataset.data_access <> 'private'
			or dataset.user_id = (select auth.uid())
			or (select public.can_view_all_private_data())
			or dataset.id in (select internal.granted_dataset_ids())
		);
$function$;

-- ---------------------------------------------------------------------------
-- Dataset views
-- ---------------------------------------------------------------------------

-- is_audited and audit_decision come from the evaluation decision (only for audit readers
-- and the owner, internal.audit_decisions)
create or replace view public.v2_full_dataset_view with (security_invoker = true) as
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
          WHERE (v2_datasets.data_access <> 'private'::access OR auth.uid() = v2_datasets.user_id OR can_view_all_private_data() OR (v2_datasets.id IN ( SELECT internal.granted_dataset_ids() AS granted_dataset_ids))) AND (v2_datasets.archived = false OR auth.uid() = v2_datasets.user_id)
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
            phenology_probability_at((meta.metadata -> 'phenology'::text) -> 'phenology_curve'::text, ds_1.aquisition_year, ds_1.aquisition_month, ds_1.aquisition_day) AS phenology_probability
           FROM v2_datasets ds_1
             LEFT JOIN v2_cogs cog ON cog.dataset_id = ds_1.id
             LEFT JOIN v2_thumbnails thumb ON thumb.dataset_id = ds_1.id
             LEFT JOIN v2_metadata meta ON meta.dataset_id = ds_1.id
          WHERE (ds_1.data_access <> 'private'::access OR auth.uid() = ds_1.user_id OR can_view_all_private_data() OR (ds_1.id IN ( SELECT internal.granted_dataset_ids() AS granted_dataset_ids))) AND (ds_1.archived = false OR auth.uid() = ds_1.user_id)
        ), label_info AS (
         SELECT dataset.id AS dataset_id,
            (EXISTS ( SELECT 1
                   FROM v2_labels
                  WHERE v2_labels.dataset_id = dataset.id AND v2_labels.label_source = 'visual_interpretation'::"LabelSource" AND v2_labels.label_data = 'deadwood'::"LabelData")) AS has_labels,
            (EXISTS ( SELECT 1
                   FROM v2_labels
                  WHERE v2_labels.dataset_id = dataset.id AND v2_labels.label_source = 'model_prediction'::"LabelSource" AND v2_labels.label_data = 'deadwood'::"LabelData")) AS has_deadwood_prediction
           FROM v2_datasets dataset
          WHERE (dataset.data_access <> 'private'::access OR auth.uid() = dataset.user_id OR can_view_all_private_data() OR (dataset.id IN ( SELECT internal.granted_dataset_ids() AS granted_dataset_ids))) AND (dataset.archived = false OR auth.uid() = dataset.user_id)
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
    audit_decision.decision IS NOT NULL AS is_audited,
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
    extra.phenology_probability,
    audit_decision.decision AS audit_decision
   FROM ds
     LEFT JOIN ortho ON ortho.dataset_id = ds.id
     LEFT JOIN status ON status.dataset_id = ds.id
     LEFT JOIN extra ON extra.dataset_id = ds.id
     LEFT JOIN label_info ON label_info.dataset_id = ds.id
     LEFT JOIN freidata_doi ON freidata_doi.dataset_id = ds.id
     LEFT JOIN correction_stats ON correction_stats.dataset_id = ds.id
     LEFT JOIN internal.audit_decisions() audit_decision(dataset_id, decision) ON audit_decision.dataset_id = ds.id;

-- The public view: every visible column of the base view (now with phenology_probability
-- and audit_decision); a dataset leaves it only when its decision is exclude.
drop view public.v2_full_dataset_view_public;
create view public.v2_full_dataset_view_public with (security_invoker = true) as
select base.*
from public.v2_full_dataset_view base
where base.archived = false
	and not (base.id in (select internal.public_surface_excluded_dataset_ids()));
grant select on public.v2_full_dataset_view_public to anon, authenticated, service_role;

-- The owner's view: the decision on their dataset instead of the saved audit's fields.
drop view public.v2_full_dataset_view_owner;
create view public.v2_full_dataset_view_owner
with (security_invoker = true, security_barrier = true) as
select
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
	base.has_error,
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
	base.is_combined_model_done,
	base.is_aoi_done,
	base.is_aoi_required,
	base.phenology_probability,
	base.is_audited,
	base.audit_decision,
	status.error_stage,
	exists (
		select 1 from public.v2_labels l
		where l.dataset_id = base.id and l.label_source = 'model_prediction'
		and l.label_data = 'forest_cover'
	) as has_forest_cover_prediction,
	public.is_dataset_in_audit(base.id) as is_in_audit
from public.v2_full_dataset_view base
left join public.v2_statuses status on status.dataset_id = base.id
where base.user_id = auth.uid();
grant select on public.v2_full_dataset_view_owner to authenticated, service_role;
revoke all on public.v2_full_dataset_view_owner from anon;

-- The owner's audit summary (dataset status drawer): the decision and when it was made,
-- null while there is none.
create or replace function public.get_dataset_status_details(p_dataset_id bigint)
returns jsonb
language sql stable security definer
set search_path to ''
as $function$
	select jsonb_build_object('dataset_id', d.id, 'audit_decision', e.decision, 'audit_decided_at', e.decided_at)
	from public.v2_datasets d
	join audit.evaluation_decisions e on e.dataset_id = d.id
	where d.id = p_dataset_id and d.user_id = auth.uid() and e.decision is not null;
$function$;

create or replace view public.v2_processing_overview with (security_invoker = true) as
SELECT DISTINCT ON (d.id) d.id AS dataset_id,
    d.file_name,
    d.created_at AS dataset_created_at,
        CASE
            WHEN COALESCE(ri.raw_image_count, 0) > 0 OR s.is_odm_done THEN 'odm'::text
            ELSE 'geotiff'::text
        END AS processing_source,
        CASE
            WHEN s.current_status <> 'idle'::v2_status AND s.has_error IS DISTINCT FROM true THEN 'PROCESSING'::text
            WHEN (EXISTS ( SELECT 1
               FROM v2_queue q
              WHERE q.dataset_id = d.id)) THEN 'QUEUED'::text
            WHEN s.has_error THEN 'FAILED'::text
            ELSE 'COMPLETED'::text
        END AS processing_status,
    s.current_status,
    s.has_error,
    s.error_message,
    EXTRACT(epoch FROM now() - s.updated_at) / 3600::numeric AS hours_since_status_update,
        CASE
            WHEN s.current_status <> 'idle'::v2_status THEN EXTRACT(epoch FROM now() - s.updated_at) / 3600::numeric
            ELSE NULL::numeric
        END AS hours_in_current_status,
    s.updated_at AS status_last_updated,
    (EXISTS ( SELECT 1
           FROM v2_queue q
          WHERE q.dataset_id = d.id)) AS is_in_queue,
    ( SELECT min(q.created_at) AS min
           FROM v2_queue q
          WHERE q.dataset_id = d.id) AS queued_at,
    ( SELECT min(q.priority) AS min
           FROM v2_queue q
          WHERE q.dataset_id = d.id) AS queue_priority,
    ( SELECT ue.email::character varying(255) AS email
           FROM get_user_emails(ARRAY[d.user_id]) ue(user_id, email)
         LIMIT 1) AS user_email,
    ui.organisation,
    s.is_upload_done,
    s.is_ortho_done,
    s.is_cog_done,
    s.is_thumbnail_done,
    s.is_deadwood_done,
    s.is_forest_cover_done,
    s.is_metadata_done,
    s.is_odm_done,
    audit_decision.decision IS NOT NULL AS is_audited,
    ( SELECT count(*) AS count
           FROM v2_aois a
          WHERE a.dataset_id = d.id) AS aoi_count,
    ( SELECT count(dg.id) AS count
           FROM v2_labels l
             LEFT JOIN v2_deadwood_geometries dg ON dg.label_id = l.id
          WHERE l.dataset_id = d.id) AS deadwood_geometry_count,
    ( SELECT count(fg.id) AS count
           FROM v2_labels l
             LEFT JOIN v2_forest_cover_geometries fg ON fg.label_id = l.id
          WHERE l.dataset_id = d.id) AS forest_cover_geometry_count,
    ri.raw_images_path,
    ri.raw_image_count,
    ri.raw_image_size_mb,
    o.ortho_file_size,
    c.cog_file_size,
    COALESCE(((o.ortho_info -> 'Profile'::text) ->> 'Width'::text)::integer, (o.ortho_info ->> 'Width'::text)::integer) AS ortho_width,
    COALESCE(((o.ortho_info -> 'Profile'::text) ->> 'Height'::text)::integer, (o.ortho_info ->> 'Height'::text)::integer) AS ortho_height,
    (o.ortho_info -> 'GEO'::text) ->> 'CRS'::text AS ortho_crs,
    (c.cog_info -> 'GEO'::text) ->> 'CRS'::text AS cog_crs,
    jsonb_strip_nulls(COALESCE(ri.camera_metadata, '{}'::jsonb) || jsonb_build_object('has_rtk_data', ri.has_rtk_data, 'rtk_precision_cm', ri.rtk_precision_cm, 'rtk_quality_indicator', ri.rtk_quality_indicator, 'rtk_file_count', ri.rtk_file_count)) AS raw_images_metadata,
    o.ortho_info AS ortho_metadata,
    c.cog_info AS cog_metadata,
    ( SELECT string_agg((((((recent_logs.level || '|'::text) || COALESCE(recent_logs.category, 'general'::text)) || '|'::text) || to_char(recent_logs.created_at, 'MM-DD HH24:MI'::text)) || '|'::text) || "substring"(recent_logs.message, 1, 100), chr(10) ORDER BY recent_logs.created_at DESC) AS string_agg
           FROM ( SELECT v2_logs.level,
                    v2_logs.category,
                    v2_logs.message,
                    v2_logs.created_at
                   FROM v2_logs
                  WHERE v2_logs.dataset_id = d.id
                  ORDER BY v2_logs.created_at DESC
                 LIMIT 20) recent_logs) AS last_20_logs,
    s.is_combined_model_done,
    s.is_aoi_done,
    s.is_aoi_required
   FROM v2_datasets d
     LEFT JOIN v2_statuses s ON s.dataset_id = d.id
     LEFT JOIN internal.audit_decisions() audit_decision(dataset_id, decision) ON audit_decision.dataset_id = d.id
     LEFT JOIN user_info ui ON ui."user" = d.user_id
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
          WHERE o_1.dataset_id = d.id
          ORDER BY o_1.created_at DESC, o_1.version DESC
         LIMIT 1) o ON true
     LEFT JOIN LATERAL ( SELECT c_1.dataset_id,
            c_1.cog_file_name,
            c_1.version,
            c_1.created_at,
            c_1.cog_info,
            c_1.cog_processing_runtime,
            c_1.cog_path,
            c_1.cog_file_size
           FROM v2_cogs c_1
          WHERE c_1.dataset_id = d.id
          ORDER BY c_1.created_at DESC, c_1.version DESC
         LIMIT 1) c ON true
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
          WHERE ri_1.dataset_id = d.id
          ORDER BY ri_1.created_at DESC, ri_1.version DESC
         LIMIT 1) ri ON true
  ORDER BY d.id DESC, (COALESCE(s.updated_at, d.created_at)) DESC
 LIMIT 100;
