\set ON_ERROR_STOP on

do $$
declare
	counts jsonb;
begin
	with expected_users(email) as (
		values
			('qa-contributor-local@example.com'),
			('qa-auditor-local@example.com'),
			('qa-viewer-local@example.com')
	),
	expected_datasets(id) as (
		values (91001), (91002), (91003), (91004)
	)
	select jsonb_build_object(
		'users', (select count(*) from auth.users u join expected_users e on e.email = u.email),
		'datasets', (select count(*) from public.v2_datasets d join expected_datasets e on e.id = d.id),
		'statuses', (select count(*) from public.v2_statuses s join expected_datasets e on e.id = s.dataset_id),
		'cogs', (select count(*) from public.v2_cogs c where c.dataset_id in (91001, 91002)),
		'thumbnails', (select count(*) from public.v2_thumbnails t where t.dataset_id in (91001, 91002)),
		'audits', (select count(*) from public.dataset_audit a where a.dataset_id = 91002),
		'flags', (select count(*) from public.dataset_flags f where f.dataset_id = 91001),
		'auditors', (select count(*) from public.privileged_users p where p.user_id = '00000000-0000-4000-8000-00000000a002'),
		'priwa_memberships', (select count(*) from public.priwa_project_memberships p where p.user_id = '00000000-0000-4000-8000-00000000a001'),
		'priwa_points', (select count(*) from public.priwa_kaeferbaeume k where k.project_id = '00000000-0000-4000-8000-00000000b001'),
		'labels', (select count(*) from public.v2_labels l where l.dataset_id = 91001),
		'deadwood_geometries', (select count(*) from public.v2_deadwood_geometries dg join public.v2_labels l on l.id = dg.label_id where l.dataset_id = 91001),
		'forest_cover_geometries', (select count(*) from public.v2_forest_cover_geometries fg join public.v2_labels l on l.id = fg.label_id where l.dataset_id = 91001),
		'publications', (select count(*) from public.data_publication p where p.user_id = '00000000-0000-4000-8000-00000000a001')
	)
	into counts;

	if counts <> jsonb_build_object(
		'users', 3,
		'datasets', 4,
		'statuses', 4,
		'cogs', 2,
		'thumbnails', 2,
		'audits', 1,
		'flags', 1,
		'auditors', 1,
		'priwa_memberships', 1,
		'priwa_points', 1,
		'labels', 2,
		'deadwood_geometries', 1,
		'forest_cover_geometries', 1,
		'publications', 1
	) then
		raise exception 'fixture check failed: %', counts;
	end if;
end $$;

select
	'qa fixtures ready' as status,
	(select count(*) from auth.users where email like 'qa-%-local@example.com') as qa_users,
	(select count(*) from public.v2_datasets where id between 91001 and 91099) as qa_datasets,
	(select count(*) from public.v2_full_dataset_view_public where id between 91001 and 91099) as qa_public_view_rows;
