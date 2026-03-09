-- Canonical polygon candidate view for downstream exports.
-- Keep this view broad and include all relevant metadata/flags.
-- Export scripts should apply use-case specific filtering logic.

create view "public"."v_export_polygon_candidates" as
with dataset_mode as (
	select
		d.id as dataset_id,
		exists (
			select 1
			from public.v2_geometry_corrections c
			join public.v2_labels l_corr on l_corr.id = c.label_id
			where l_corr.dataset_id = d.id
				and l_corr.label_source = 'model_prediction'
				and l_corr.is_active = true
				and c.review_status = 'pending'
				and c.operation in ('add', 'modify')
		) as has_pending_model_edits
	from public.v2_datasets d
),
deadwood as (
	select
		'deadwood'::text as layer_type,
		dg.id as geometry_id,
		dg.label_id,
		l.dataset_id,
		l.label_source::text as label_source,
		l.label_data::text as label_data,
		l.is_active,
		coalesce(dg.is_deleted, false) as is_deleted,
		not exists (
			select 1
			from public.v2_geometry_corrections c
			where c.geometry_id = dg.id
				and c.layer_type = 'deadwood'
				and c.operation in ('add', 'modify')
		) as is_original_prediction_geometry,
		dg.geometry,
		dg.area_m2,
		dg.properties,
		dg.created_at,
		dg.updated_at
	from public.v2_deadwood_geometries dg
	join public.v2_labels l on l.id = dg.label_id
),
forest_cover as (
	select
		'forest_cover'::text as layer_type,
		fg.id as geometry_id,
		fg.label_id,
		l.dataset_id,
		l.label_source::text as label_source,
		l.label_data::text as label_data,
		l.is_active,
		coalesce(fg.is_deleted, false) as is_deleted,
		not exists (
			select 1
			from public.v2_geometry_corrections c
			where c.geometry_id = fg.id
				and c.layer_type = 'forest_cover'
				and c.operation in ('add', 'modify')
		) as is_original_prediction_geometry,
		fg.geometry,
		fg.area_m2,
		fg.properties,
		fg.created_at,
		fg.updated_at
	from public.v2_forest_cover_geometries fg
	join public.v2_labels l on l.id = fg.label_id
),
all_polygons as (
	select * from deadwood
	union all
	select * from forest_cover
)
select
	p.layer_type,
	p.geometry_id as id,
	p.label_id,
	p.dataset_id,
	p.label_source,
	p.label_data,
	p.is_active,
	p.is_deleted,
	p.is_original_prediction_geometry,
	dm.has_pending_model_edits,
	case
		when dm.has_pending_model_edits then 'original'
		else 'active'
	end as recommended_export_mode,
	da.final_assessment,
	da.deadwood_quality::text as deadwood_quality,
	da.forest_cover_quality::text as forest_cover_quality,
	p.geometry,
	p.area_m2,
	p.properties,
	p.created_at,
	p.updated_at
from all_polygons p
left join public.dataset_audit da on da.dataset_id = p.dataset_id
join dataset_mode dm on dm.dataset_id = p.dataset_id;

