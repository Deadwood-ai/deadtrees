update public.prepackaged_dataset_versions dataset_version
set storage_path = package.storage_path
from (
	values
		(
			'tree-cover-aerial-global',
			'2026.04.17',
			'prepackaged/v2026-04-17/tree-cover-aerial-global_2026.04.17.zip'
		),
		(
			'standing-deadwood-aerial-global-conservative',
			'2026.04.17',
			'prepackaged/v2026-04-17/standing-deadwood-aerial-global-conservative_2026.04.17.zip'
		),
		(
			'image-tiles-1024-global-aerial-sampled-20-random',
			'2026.04.17',
			'prepackaged/v2026-04-17/image-tiles-1024-global-aerial-sampled-20-random_2026.04.17.zip'
		)
) as package(slug, package_version, storage_path)
join public.prepackaged_dataset_definitions definition on definition.slug = package.slug
where dataset_version.definition_id = definition.id
	and dataset_version.version = package.package_version;

grant select on table "public"."v2_full_dataset_view" to "anon";
grant select on table "public"."v2_full_dataset_view" to "authenticated";
grant select on table "public"."v2_full_dataset_view" to "service_role";

grant select on table "public"."v2_labels" to "anon";
grant select on table "public"."v2_labels" to "authenticated";
grant select on table "public"."v2_labels" to "service_role";
