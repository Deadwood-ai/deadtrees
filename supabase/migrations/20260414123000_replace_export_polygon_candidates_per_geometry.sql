-- Replace dataset-level export fallback with per-geometry resolution.
-- Approved deletes must win over approved adds/modifies so a geometry that was
-- added and later deleted is not exported again.

create or replace view "public"."v_export_polygon_candidates" as
with correction_flags as (
	select
		c.layer_type,
		c.geometry_id,
		c.original_geometry_id,
		bool_or(c.operation = 'add' and c.review_status = 'approved') as has_approved_add,
		bool_or(c.operation = 'modify' and c.review_status = 'approved') as has_approved_modify,
		bool_or(c.operation = 'delete' and c.review_status = 'approved') as has_approved_delete,
		bool_or(c.operation = 'add' and coalesce(c.review_status, '') not in ('approved', 'rejected')) as has_pending_add,
		bool_or(c.operation = 'modify' and coalesce(c.review_status, '') not in ('approved', 'rejected')) as has_pending_modify,
		bool_or(c.operation = 'delete' and coalesce(c.review_status, '') not in ('approved', 'rejected')) as has_pending_delete
	from public.v2_geometry_corrections c
	group by
		c.layer_type,
		c.geometry_id,
		c.original_geometry_id
),
approved_replacements as (
	select
		layer_type,
		original_geometry_id as geometry_id,
		bool_or(has_approved_modify) as replaced_by_approved_modify
	from correction_flags
	where original_geometry_id is not null
	group by layer_type, original_geometry_id
),
deadwood as (
	select
		'deadwood'::text as layer_type,
		dg.id as geometry_id,
		dg.label_id,
		l.dataset_id,
		l.label_source::text as label_source,
		l.is_active as label_is_active,
		coalesce(dg.is_deleted, false) as is_deleted_in_table,
		coalesce(cf.has_approved_add, false) as has_approved_add,
		coalesce(cf.has_approved_modify, false) as has_approved_modify,
		coalesce(cf.has_approved_delete, false) as has_approved_delete,
		coalesce(cf.has_pending_add, false) as has_pending_add,
		coalesce(cf.has_pending_modify, false) as has_pending_modify,
		coalesce(cf.has_pending_delete, false) as has_pending_delete,
		coalesce(ar.replaced_by_approved_modify, false) as replaced_by_approved_modify,
		dg.geometry,
		dg.area_m2,
		dg.properties,
		dg.created_at,
		dg.updated_at
	from public.v2_deadwood_geometries dg
	join public.v2_labels l on l.id = dg.label_id
	left join correction_flags cf
		on cf.layer_type = 'deadwood'
		and cf.geometry_id = dg.id
	left join approved_replacements ar
		on ar.layer_type = 'deadwood'
		and ar.geometry_id = dg.id
	where l.label_source = 'model_prediction'::"LabelSource"
),
forest_cover as (
	select
		'forest_cover'::text as layer_type,
		fg.id as geometry_id,
		fg.label_id,
		l.dataset_id,
		l.label_source::text as label_source,
		l.is_active as label_is_active,
		coalesce(fg.is_deleted, false) as is_deleted_in_table,
		coalesce(cf.has_approved_add, false) as has_approved_add,
		coalesce(cf.has_approved_modify, false) as has_approved_modify,
		coalesce(cf.has_approved_delete, false) as has_approved_delete,
		coalesce(cf.has_pending_add, false) as has_pending_add,
		coalesce(cf.has_pending_modify, false) as has_pending_modify,
		coalesce(cf.has_pending_delete, false) as has_pending_delete,
		coalesce(ar.replaced_by_approved_modify, false) as replaced_by_approved_modify,
		fg.geometry,
		fg.area_m2,
		fg.properties,
		fg.created_at,
		fg.updated_at
	from public.v2_forest_cover_geometries fg
	join public.v2_labels l on l.id = fg.label_id
	left join correction_flags cf
		on cf.layer_type = 'forest_cover'
		and cf.geometry_id = fg.id
	left join approved_replacements ar
		on ar.layer_type = 'forest_cover'
		and ar.geometry_id = fg.id
	where l.label_source = 'model_prediction'::"LabelSource"
),
resolved_polygons as (
	select
		p.layer_type,
		p.geometry_id as id,
		p.label_id,
		p.dataset_id,
		p.label_source,
		case
			when p.has_approved_delete then false
			when p.replaced_by_approved_modify then false
			when p.has_approved_add or p.has_approved_modify then true
			when p.has_pending_add or p.has_pending_modify then false
			when p.has_pending_delete then true
			else not p.is_deleted_in_table
		end as is_active,
		p.is_deleted_in_table as is_deleted,
		not (
			p.has_approved_add
			or p.has_approved_modify
			or p.has_pending_add
			or p.has_pending_modify
		) as is_original_prediction_geometry,
		false as has_pending_model_edits,
		'approved_state'::text as recommended_export_mode,
		p.label_is_active,
		p.geometry,
		p.area_m2,
		p.properties,
		p.created_at,
		p.updated_at
	from (
		select * from deadwood
		union all
		select * from forest_cover
	) p
)
select
	p.layer_type,
	p.id,
	p.label_id,
	p.dataset_id,
	p.label_source,
	p.is_active,
	p.is_deleted,
	p.is_original_prediction_geometry,
	p.has_pending_model_edits,
	p.recommended_export_mode,
	da.final_assessment,
	da.deadwood_quality::text as deadwood_quality,
	da.forest_cover_quality::text as forest_cover_quality,
	p.geometry,
	p.area_m2,
	p.properties,
	p.created_at,
	p.updated_at
from resolved_polygons p
left join public.dataset_audit da on da.dataset_id = p.dataset_id
where p.is_active and p.label_is_active;
