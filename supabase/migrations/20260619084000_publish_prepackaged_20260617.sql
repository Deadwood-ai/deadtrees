create temporary table prepackaged_20260617_package (
	slug text not null,
	version text not null,
	file_name text not null,
	storage_path text not null,
	public_download_path text not null,
	size_bytes bigint not null,
	dataset_count integer not null,
	artifact_count integer not null,
	built_at timestamptz not null,
	source_commit text not null,
	source_package_version text not null,
	manifest jsonb not null,
	known_issues text
) on commit drop;

insert into prepackaged_20260617_package
	(
		slug,
		version,
		file_name,
		storage_path,
		public_download_path,
		size_bytes,
		dataset_count,
		artifact_count,
		built_at,
		source_commit,
		source_package_version,
		manifest,
		known_issues
	)
values
		(
			'tree-cover-aerial-global',
			'2026.06.17',
			'tree-cover-aerial-global_2026.06.17.zip',
			'prepackaged/v2026-06-17/tree-cover-aerial-global_2026.06.17.zip',
			'/prepackaged/v1/tree-cover-aerial-global_2026.06.17.zip',
			3089283719::bigint,
			4664,
			1,
			'2026-06-17T23:24:10.086103+00:00'::timestamptz,
			'feffe7b73d2ec3159260a6d3fddf7e5ac9ae855a',
			'0.1.0',
			'{
				"artifacts": [
					"tree-cover-aerial-global_2026.06.17.gpkg",
					"METADATA.csv",
					"METADATA.parquet",
					"LICENSE.txt",
					"manifest.json"
				],
				"built_at": "2026-06-17T23:24:10.086103+00:00",
				"dataset_count": 4664,
				"dataset_name": "tree-cover-aerial-global",
				"package_name": "tree-cover-aerial-global_2026.06.17",
				"source_reference": {
					"file": "deadtrees_prepackaged/datasets/tree_cover_aerial_global.py",
					"package_version": "0.1.0"
				},
				"test_mode": false,
				"tree_cover_feature_count": 3255345,
				"used_dataset_count": 4664,
				"version": "2026.06.17"
			}'::jsonb,
			null::text
		),
		(
			'standing-deadwood-aerial-global-conservative',
			'2026.06.17',
			'standing-deadwood-aerial-global-conservative_2026.06.17.zip',
			'prepackaged/v2026-06-17/standing-deadwood-aerial-global-conservative_2026.06.17.zip',
			'/prepackaged/v1/standing-deadwood-aerial-global-conservative_2026.06.17.zip',
			1156624120::bigint,
			2034,
			1,
			'2026-06-17T18:34:39.777060+00:00'::timestamptz,
			'feffe7b73d2ec3159260a6d3fddf7e5ac9ae855a',
			'0.1.0',
			'{
				"artifacts": [
					"standing-deadwood-aerial-global-conservative_2026.06.17.gpkg",
					"METADATA.csv",
					"METADATA.parquet",
					"LICENSE.txt",
					"manifest.json"
				],
				"built_at": "2026-06-17T18:34:39.777060+00:00",
				"dataset_count": 2034,
				"dataset_name": "standing-deadwood-aerial-global-conservative",
				"package_name": "standing-deadwood-aerial-global-conservative_2026.06.17",
				"source_reference": {
					"file": "deadtrees_prepackaged/datasets/standing_deadwood_aerial_global_conservative.py",
					"package_version": "0.1.0"
				},
				"test_mode": false,
				"tree_cover_feature_count": 1133639,
				"used_dataset_count": 2034,
				"version": "2026.06.17"
			}'::jsonb,
			null::text
		),
		(
			'image-tiles-1024-global-aerial-sampled-20-random',
			'2026.06.17',
			'image-tiles-1024-global-aerial-sampled-20-random_2026.06.17.zip',
			'prepackaged/v2026-06-17/image-tiles-1024-global-aerial-sampled-20-random_2026.06.17.zip',
			'/prepackaged/v1/image-tiles-1024-global-aerial-sampled-20-random_2026.06.17.zip',
			308630440965::bigint,
			4719,
			87586,
			'2026-06-18T02:14:23.420643+00:00'::timestamptz,
			'feffe7b73d2ec3159260a6d3fddf7e5ac9ae855a',
			'0.1.0',
			'{
				"artifacts": [
					"tiles/",
					"METADATA.csv",
					"METADATA.parquet",
					"TILES.csv",
					"TILES.parquet",
					"LICENSE.txt",
					"manifest.json"
				],
				"built_at": "2026-06-18T02:14:23.420643+00:00",
				"dataset_count": 4719,
				"dataset_name": "image-tiles-1024-global-aerial-sampled-20-random",
				"package_name": "image-tiles-1024-global-aerial-sampled-20-random_2026.06.17",
				"source_reference": {
					"file": "deadtrees_prepackaged/datasets/image_tiles_1024_global_aerial_sampled_20_random.py",
					"package_version": "0.1.0"
				},
				"test_mode": false,
				"tile_count": 87783,
				"used_dataset_count": 4719,
				"version": "2026.06.17",
				"verified_zip_entry_count": 87592,
				"verified_tile_file_count": 87586,
				"verified_tiles_csv_rows": 87783
			}'::jsonb,
			'Tile package counts should be revalidated before broad public release; manifest tile_count/TILES.csv rows and GeoTIFF file count differ.'::text
		)
		;

do $$
declare
	matched_definition_count integer;
begin
	select count(*)
	into matched_definition_count
	from prepackaged_20260617_package package
	join public.prepackaged_dataset_definitions definition on definition.slug = package.slug;

	if matched_definition_count <> 3 then
		raise exception 'Expected 3 prepackaged dataset definitions for 2026.06.17, found %', matched_definition_count;
	end if;
end $$;

insert into public.prepackaged_dataset_versions
	(
		definition_id,
		version,
		status,
		file_name,
		storage_path,
		public_download_path,
		size_bytes,
		checksum_sha256,
		dataset_count,
		artifact_count,
		built_at,
		published_at,
		source_commit,
		source_package_version,
		manifest,
		known_issues
	)
select
	definition.id,
	package.version,
	'available'::prepackaged_dataset_version_status,
	package.file_name,
	package.storage_path,
	package.public_download_path,
	package.size_bytes,
	null,
	package.dataset_count,
	package.artifact_count,
	package.built_at,
	now(),
	package.source_commit,
	package.source_package_version,
	package.manifest,
	package.known_issues
from prepackaged_20260617_package package
join public.prepackaged_dataset_definitions definition on definition.slug = package.slug
on conflict (definition_id, version) do update
set
	status = excluded.status,
	file_name = excluded.file_name,
	storage_path = excluded.storage_path,
	public_download_path = excluded.public_download_path,
	size_bytes = excluded.size_bytes,
	checksum_sha256 = excluded.checksum_sha256,
	dataset_count = excluded.dataset_count,
	artifact_count = excluded.artifact_count,
	built_at = excluded.built_at,
	published_at = excluded.published_at,
	source_commit = excluded.source_commit,
	source_package_version = excluded.source_package_version,
	manifest = excluded.manifest,
	known_issues = excluded.known_issues;
