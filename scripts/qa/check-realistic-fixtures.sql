\set ON_ERROR_STOP on

do $$
declare
	counts jsonb;
begin
	select jsonb_build_object(
		'datasets', (select count(*) from public.v2_datasets where id between 92001 and 92099),
		'statuses', (select count(*) from public.v2_statuses where dataset_id between 92001 and 92099),
		'cogs', (select count(*) from public.v2_cogs where dataset_id between 92001 and 92099),
		'thumbnails', (select count(*) from public.v2_thumbnails where dataset_id between 92001 and 92099),
		'metadata', (select count(*) from public.v2_metadata where dataset_id between 92001 and 92099),
		'audits', (select count(*) from public.dataset_audit where dataset_id between 92001 and 92099),
		'labels', (select count(*) from public.v2_labels where dataset_id between 92001 and 92099),
		'deadwood_geometries', (
			select count(*)
			from public.v2_deadwood_geometries geom
			join public.v2_labels label on label.id = geom.label_id
			where label.dataset_id between 92001 and 92099
		),
		'forest_cover_geometries', (
			select count(*)
			from public.v2_forest_cover_geometries geom
			join public.v2_labels label on label.id = geom.label_id
			where label.dataset_id between 92001 and 92099
		),
		'corrections', (select count(*) from public.v2_geometry_corrections where dataset_id between 92001 and 92099),
		'errored_datasets', (select count(*) from public.v2_statuses where dataset_id between 92001 and 92099 and has_error),
		'public_view_rows', (select count(*) from public.v2_full_dataset_view_public where id between 92001 and 92099)
	)
	into counts;

	if (counts->>'datasets')::int < 4
		or (counts->>'statuses')::int < 4
		or (counts->>'cogs')::int < 4
		or (counts->>'thumbnails')::int < 4
		or (counts->>'metadata')::int < 4
		or (counts->>'audits')::int < 1
		or (counts->>'labels')::int < 4
		or (counts->>'deadwood_geometries')::int < 1
		or (counts->>'forest_cover_geometries')::int < 1
		or (counts->>'corrections')::int < 1
		or (counts->>'errored_datasets')::int < 1
		or (counts->>'public_view_rows')::int < 4 then
		raise exception 'realistic fixture check failed: %', counts;
	end if;
end $$;

select
	'qa realistic fixtures ready' as status,
	(select count(*) from public.v2_datasets where id between 92001 and 92099) as qa_realistic_datasets,
	(select count(*) from public.v2_labels where dataset_id between 92001 and 92099) as qa_realistic_labels,
	(select count(*) from public.v2_geometry_corrections where dataset_id between 92001 and 92099) as qa_realistic_corrections,
	(select count(*) from public.v2_full_dataset_view_public where id between 92001 and 92099) as qa_realistic_public_view_rows;
