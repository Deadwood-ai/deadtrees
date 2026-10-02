-- Dataset sharing, part 2: every existing visibility check honours grants.
--
-- Child tables follow their dataset row through internal.hidden_private_dataset_ids();
-- audit exclusion and search keep shared datasets visible to their grantees; and
-- the dataset row, derived-output policies and dataset views gain the grant term
-- internal.granted_dataset_ids(). Part 1 (20261002100000) defines both helpers.

begin;

-- ---------------------------------------------------------------------------
-- Child tables that were readable by everyone, including rows of private datasets
-- (for example the COG path in v2_cogs), now follow their dataset row.
-- ---------------------------------------------------------------------------

do $$
declare
	child_table text;
begin
	foreach child_table in array array[
		'v2_cogs', 'v2_thumbnails', 'v2_orthos', 'v2_orthos_processed', 'v2_metadata',
		'v2_raw_images', 'v2_statuses', 'v2_queue'
	] loop
		execute format(
			'alter policy "Enable read access for all users" on public.%I '
			'using (dataset_id not in (select internal.hidden_private_dataset_ids()))',
			child_table
		);
	end loop;
end;
$$;

alter policy "Public read corrections" on public.v2_geometry_corrections
using (dataset_id not in (select internal.hidden_private_dataset_ids()));

alter policy "Enable read access for all users" on public.jt_data_publication_datasets
using (dataset_id not in (select internal.hidden_private_dataset_ids()));

-- ---------------------------------------------------------------------------
-- Audit exclusion and search: a grantee keeps seeing a dataset shared with them
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
			and exists (
				select 1
				from public.dataset_audit audit
				where audit.dataset_id = dataset.id
					and audit.final_assessment = 'exclude_completely'
			)
	);
$function$;

create or replace function internal.public_surface_excluded_dataset_ids()
returns setof bigint
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
	select dataset.id
	from public.v2_datasets dataset
	where dataset.id in (
			select audit.dataset_id
			from public.dataset_audit audit
			where audit.final_assessment = 'exclude_completely'
		)
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

create or replace function public.is_dataset_search_visible(p_dataset_id bigint)
returns boolean
language sql stable security definer
set search_path to 'public'
as $function$
  select exists (
    select 1
    from public.v2_datasets d
    where d.id = p_dataset_id
      and (
        d.data_access <> 'private'::access
        or auth.uid() = d.user_id
        or can_view_all_private_data()
        or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
        or d.id in (select internal.granted_dataset_ids())
      )
      and (
        d.archived = false
        or auth.uid() = d.user_id
      )
      and (
        auth.uid() = d.user_id
        or can_view_all_private_data()
        or ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)
        or not internal.is_dataset_excluded_from_public_surface(d.id)
      )
  );
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
      and (
        d.user_id = uid
        or sees_all
        or d.id = any (granted)
        or not exists (
          select 1 from public.dataset_audit a
          where a.dataset_id = d.id and a.final_assessment = 'exclude_completely'
        )
      )
  ), '{}');
end;
$function$;

-- ---------------------------------------------------------------------------
-- Dataset rows, derived outputs and dataset views: the private branch honours grants
-- (generated from the current definitions; only the grant term is added)
-- ---------------------------------------------------------------------------

alter policy "Enable read access for all users" on public.v2_datasets
using (((data_access <> 'private'::access) OR (( SELECT auth.uid() AS uid) = user_id) OR ( SELECT can_view_all_private_data() AS can_view_all_private_data)) OR (id IN ( SELECT internal.granted_dataset_ids() AS granted_dataset_ids)));

alter policy "Allow visible dataset labels read access" on public.v2_labels
using ((EXISTS ( SELECT 1
   FROM v2_datasets dataset
  WHERE ((dataset.id = v2_labels.dataset_id) AND ((dataset.data_access <> 'private'::access OR dataset.id IN (SELECT internal.granted_dataset_ids())) OR (( SELECT auth.uid() AS uid) = dataset.user_id) OR ( SELECT can_view_all_private_data() AS can_view_all_private_data)) AND ((dataset.archived = false) OR (( SELECT auth.uid() AS uid) = dataset.user_id)) AND ((( SELECT auth.uid() AS uid) = dataset.user_id) OR ( SELECT can_view_all_private_data() AS can_view_all_private_data) OR (NOT (dataset.id IN ( SELECT internal.public_surface_excluded_dataset_ids() AS public_surface_excluded_dataset_ids))))))));

alter policy "Allow visible dataset deadwood geometries read access" on public.v2_deadwood_geometries
using ((EXISTS ( SELECT 1
   FROM (v2_labels label
     JOIN v2_datasets dataset ON ((dataset.id = label.dataset_id)))
  WHERE ((label.id = v2_deadwood_geometries.label_id) AND ((dataset.data_access <> 'private'::access OR dataset.id IN (SELECT internal.granted_dataset_ids())) OR (auth.uid() = dataset.user_id) OR can_view_all_private_data()) AND ((dataset.archived = false) OR (auth.uid() = dataset.user_id)) AND ((auth.uid() = dataset.user_id) OR can_view_all_private_data() OR (NOT internal.is_dataset_excluded_from_public_surface(dataset.id)))))));

alter policy "Allow visible dataset forest cover geometries read access" on public.v2_forest_cover_geometries
using ((EXISTS ( SELECT 1
   FROM (v2_labels label
     JOIN v2_datasets dataset ON ((dataset.id = label.dataset_id)))
  WHERE ((label.id = v2_forest_cover_geometries.label_id) AND ((dataset.data_access <> 'private'::access OR dataset.id IN (SELECT internal.granted_dataset_ids())) OR (auth.uid() = dataset.user_id) OR can_view_all_private_data()) AND ((dataset.archived = false) OR (auth.uid() = dataset.user_id)) AND ((auth.uid() = dataset.user_id) OR can_view_all_private_data() OR (NOT internal.is_dataset_excluded_from_public_surface(dataset.id)))))));

alter policy "Allow public read access to AOIs" on public.v2_aois
using ((EXISTS ( SELECT 1
   FROM v2_datasets d
  WHERE ((d.id = v2_aois.dataset_id) AND ((d.data_access <> 'private'::access OR d.id IN (SELECT internal.granted_dataset_ids())) OR (auth.uid() = d.user_id) OR can_view_all_private_data() OR ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)) AND ((d.archived = false) OR (auth.uid() = d.user_id)) AND ((auth.uid() = d.user_id) OR can_view_all_private_data() OR ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text) OR (NOT internal.is_dataset_excluded_from_public_surface(d.id)))))));

alter policy "Allow read access to acquisition date estimates" on public.v2_acquisition_date_estimates
using ((EXISTS ( SELECT 1
   FROM v2_datasets d
  WHERE ((d.id = v2_acquisition_date_estimates.dataset_id) AND ((d.data_access <> 'private'::access OR d.id IN (SELECT internal.granted_dataset_ids())) OR (auth.uid() = d.user_id) OR can_view_all_private_data() OR ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)) AND ((d.archived = false) OR (auth.uid() = d.user_id))))));

alter policy "Read acquisition date decisions like the dataset" on public.acquisition_date_decisions
using ((EXISTS ( SELECT 1
   FROM v2_datasets d
  WHERE ((d.id = acquisition_date_decisions.dataset_id) AND ((d.data_access <> 'private'::access OR d.id IN (SELECT internal.granted_dataset_ids())) OR (auth.uid() = d.user_id) OR can_view_all_private_data() OR ((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text)) AND ((d.archived = false) OR (auth.uid() = d.user_id))))));

create or replace view public.v2_full_dataset_view with (security_invoker=true) as
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
          WHERE (v2_datasets.data_access <> 'private'::access OR auth.uid() = v2_datasets.user_id OR can_view_all_private_data() OR v2_datasets.id IN (SELECT internal.granted_dataset_ids())) AND (v2_datasets.archived = false OR auth.uid() = v2_datasets.user_id)
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
            phenology_probability_at((meta.metadata -> 'phenology'::text) -> 'phenology_curve'::text, ds_1.aquisition_year, ds_1.aquisition_month, ds_1.aquisition_day) AS phenology_probability
           FROM v2_datasets ds_1
             LEFT JOIN v2_cogs cog ON cog.dataset_id = ds_1.id
             LEFT JOIN v2_thumbnails thumb ON thumb.dataset_id = ds_1.id
             LEFT JOIN v2_metadata meta ON meta.dataset_id = ds_1.id
          WHERE (ds_1.data_access <> 'private'::access OR auth.uid() = ds_1.user_id OR can_view_all_private_data() OR ds_1.id IN (SELECT internal.granted_dataset_ids())) AND (ds_1.archived = false OR auth.uid() = ds_1.user_id)
        ), label_info AS (
         SELECT dataset.id AS dataset_id,
            (EXISTS ( SELECT 1
                   FROM v2_labels
                  WHERE v2_labels.dataset_id = dataset.id AND v2_labels.label_source = 'visual_interpretation'::"LabelSource" AND v2_labels.label_data = 'deadwood'::"LabelData")) AS has_labels,
            (EXISTS ( SELECT 1
                   FROM v2_labels
                  WHERE v2_labels.dataset_id = dataset.id AND v2_labels.label_source = 'model_prediction'::"LabelSource" AND v2_labels.label_data = 'deadwood'::"LabelData")) AS has_deadwood_prediction
           FROM v2_datasets dataset
          WHERE (dataset.data_access <> 'private'::access OR auth.uid() = dataset.user_id OR can_view_all_private_data() OR dataset.id IN (SELECT internal.granted_dataset_ids())) AND (dataset.archived = false OR auth.uid() = dataset.user_id)
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

create or replace view public.public_dataset_archive_items with (security_invoker=true) as
 WITH latest_status AS (
         SELECT DISTINCT ON (v2_statuses.dataset_id) v2_statuses.dataset_id,
            v2_statuses.is_cog_done,
            v2_statuses.is_thumbnail_done,
            v2_statuses.is_deadwood_done,
            v2_statuses.is_forest_cover_done,
            v2_statuses.is_metadata_done,
            v2_statuses.has_error
           FROM v2_statuses
          ORDER BY v2_statuses.dataset_id, v2_statuses.updated_at DESC, v2_statuses.id DESC
        ), archive_base AS (
         SELECT d.id,
            d.created_at,
            d.license,
            d.platform,
            d.authors,
            d.aquisition_year,
            d.aquisition_month,
            d.aquisition_day,
            o.bbox,
            thumb.thumbnail_path,
            ((meta.metadata ->> 'gadm'::text)::jsonb) ->> 'admin_level_1'::text AS admin_level_1,
            ((meta.metadata ->> 'gadm'::text)::jsonb) ->> 'admin_level_2'::text AS admin_level_2,
            ((meta.metadata ->> 'gadm'::text)::jsonb) ->> 'admin_level_3'::text AS admin_level_3,
            ((meta.metadata ->> 'biome'::text)::jsonb) ->> 'biome_name'::text AS biome_name,
            d.data_access
           FROM v2_datasets d
             JOIN latest_status s ON s.dataset_id = d.id
             JOIN v2_orthos o ON o.dataset_id = d.id
             LEFT JOIN v2_thumbnails thumb ON thumb.dataset_id = d.id
             LEFT JOIN v2_metadata meta ON meta.dataset_id = d.id
          WHERE (d.data_access <> 'private'::access OR (( SELECT auth.uid() AS uid)) = d.user_id OR ( SELECT can_view_all_private_data() AS can_view_all_private_data) OR d.id IN (SELECT internal.granted_dataset_ids())) AND d.archived = false AND s.is_cog_done = true AND s.is_thumbnail_done = true AND s.is_metadata_done = true AND (s.has_error = false OR s.is_deadwood_done = true AND s.is_forest_cover_done = false) AND NOT (d.id IN ( SELECT internal.public_surface_excluded_dataset_ids() AS public_surface_excluded_dataset_ids))
        )
 SELECT base.id,
    base.created_at,
    base.license,
    base.platform,
    base.authors,
    base.aquisition_year,
    base.aquisition_month,
    base.aquisition_day,
    base.bbox,
    base.thumbnail_path,
    base.admin_level_1,
    base.admin_level_2,
    base.admin_level_3,
    base.biome_name,
    (EXISTS ( SELECT 1
           FROM v2_labels label
          WHERE label.dataset_id = base.id AND label.label_source = 'visual_interpretation'::"LabelSource" AND label.label_data = 'deadwood'::"LabelData")) AS has_labels,
    (EXISTS ( SELECT 1
           FROM v2_labels label
          WHERE label.dataset_id = base.id AND label.label_source = 'model_prediction'::"LabelSource" AND label.label_data = 'deadwood'::"LabelData")) AS has_deadwood_prediction,
    base.data_access
   FROM archive_base base
  WHERE base.admin_level_1 IS NOT NULL;

commit;
