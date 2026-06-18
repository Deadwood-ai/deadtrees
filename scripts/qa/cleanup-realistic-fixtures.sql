\set ON_ERROR_STOP on

begin;

delete from public.dataset_flag_status_history where flag_id in (
	select id from public.dataset_flags where dataset_id between 92001 and 92099
);
delete from public.dataset_flags where dataset_id between 92001 and 92099;
delete from public.dataset_audit where dataset_id between 92001 and 92099;
delete from public.v2_geometry_corrections where dataset_id between 92001 and 92099;
delete from public.v2_deadwood_geometries where label_id in (
	select id from public.v2_labels where dataset_id between 92001 and 92099
);
delete from public.v2_forest_cover_geometries where label_id in (
	select id from public.v2_labels where dataset_id between 92001 and 92099
);
delete from public.v2_labels where dataset_id between 92001 and 92099;
delete from public.v2_logs where dataset_id between 92001 and 92099;
delete from public.v2_queue where dataset_id between 92001 and 92099;
delete from public.v2_metadata where dataset_id between 92001 and 92099;
delete from public.v2_thumbnails where dataset_id between 92001 and 92099;
delete from public.v2_cogs where dataset_id between 92001 and 92099;
delete from public.v2_orthos where dataset_id between 92001 and 92099;
delete from public.v2_statuses where dataset_id between 92001 and 92099;
delete from public.v2_datasets where id between 92001 and 92099;

commit;
