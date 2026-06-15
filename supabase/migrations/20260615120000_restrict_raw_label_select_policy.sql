drop policy if exists "Allow public read access to labels" on "public"."v2_labels";
drop policy if exists "Allow public read access to deadwood geometries" on "public"."v2_deadwood_geometries";
drop policy if exists "Allow public read access to forest cover geometries" on "public"."v2_forest_cover_geometries";
drop policy if exists "Allow visible dataset labels read access" on "public"."v2_labels";
drop policy if exists "Allow visible dataset deadwood geometries read access" on "public"."v2_deadwood_geometries";
drop policy if exists "Allow visible dataset forest cover geometries read access" on "public"."v2_forest_cover_geometries";
drop function if exists public.is_dataset_excluded_from_public_surface(bigint);

create schema if not exists internal;

create or replace function internal.is_dataset_excluded_from_public_surface(p_dataset_id bigint)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
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
			and exists (
				select 1
				from public.dataset_audit audit
				where audit.dataset_id = dataset.id
					and audit.final_assessment = 'exclude_completely'
			)
	);
$function$;

revoke all on function internal.is_dataset_excluded_from_public_surface(bigint) from public;
grant usage on schema internal to anon, authenticated, service_role;
grant execute on function internal.is_dataset_excluded_from_public_surface(bigint) to anon, authenticated, service_role;

grant select on table "public"."v2_labels" to anon, authenticated, service_role;
grant select on table "public"."v2_deadwood_geometries" to anon, authenticated, service_role;
grant select on table "public"."v2_forest_cover_geometries" to anon, authenticated, service_role;

grant insert, update, delete on table "public"."v2_labels" to service_role;
grant insert, update, delete on table "public"."v2_deadwood_geometries" to service_role;
grant insert, update, delete on table "public"."v2_forest_cover_geometries" to service_role;
grant usage, select on sequence "public"."v2_labels_id_seq" to service_role;
grant usage, select on sequence "public"."v2_deadwood_geometries_id_seq" to service_role;
grant usage, select on sequence "public"."v2_forest_cover_geometries_id_seq" to service_role;

create policy "Allow visible dataset labels read access"
on "public"."v2_labels"
for select
to public
using (
	exists (
		select 1
		from public.v2_datasets dataset
		where dataset.id = v2_labels.dataset_id
			and (
				dataset.data_access <> 'private'::access
				or auth.uid() = dataset.user_id
				or public.can_view_all_private_data()
			)
			and (
				dataset.archived = false
				or auth.uid() = dataset.user_id
			)
			and (
				auth.uid() = dataset.user_id
				or public.can_view_all_private_data()
				or not internal.is_dataset_excluded_from_public_surface(dataset.id)
			)
	)
);

create policy "Allow visible dataset deadwood geometries read access"
on "public"."v2_deadwood_geometries"
for select
to public
using (
	exists (
		select 1
		from public.v2_labels label
		join public.v2_datasets dataset on dataset.id = label.dataset_id
		where label.id = v2_deadwood_geometries.label_id
			and (
				dataset.data_access <> 'private'::access
				or auth.uid() = dataset.user_id
				or public.can_view_all_private_data()
			)
			and (
				dataset.archived = false
				or auth.uid() = dataset.user_id
			)
			and (
				auth.uid() = dataset.user_id
				or public.can_view_all_private_data()
				or not internal.is_dataset_excluded_from_public_surface(dataset.id)
			)
	)
);

create policy "Allow visible dataset forest cover geometries read access"
on "public"."v2_forest_cover_geometries"
for select
to public
using (
	exists (
		select 1
		from public.v2_labels label
		join public.v2_datasets dataset on dataset.id = label.dataset_id
		where label.id = v2_forest_cover_geometries.label_id
			and (
				dataset.data_access <> 'private'::access
				or auth.uid() = dataset.user_id
				or public.can_view_all_private_data()
			)
			and (
				dataset.archived = false
				or auth.uid() = dataset.user_id
			)
			and (
				auth.uid() = dataset.user_id
				or public.can_view_all_private_data()
				or not internal.is_dataset_excluded_from_public_surface(dataset.id)
			)
	)
);
