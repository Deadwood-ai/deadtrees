alter table "public"."prepackaged_dataset_definitions"
add column if not exists "technical_description" text,
add column if not exists "source_repository_url" text,
add column if not exists "source_file_path" text;

alter table "public"."prepackaged_dataset_versions"
add column if not exists "source_commit" text,
add column if not exists "source_package_version" text;

update public.prepackaged_dataset_definitions
set
    technical_description = 'Dataset-level eligibility starts from audited deadtrees.earth records that are public, CC BY licensed, not archived, and have a complete acquisition date. Tree-cover polygon eligibility is then restricted to outputs that passed the export quality checks for forest cover. For each eligible dataset, tree-cover polygons are loaded, clipped to the dataset AOI, reduced to polygonal geometries only, and appended incrementally to a single GeoPackage tree_cover layer. Datasets that yield no remaining polygons after loading or AOI clipping are excluded from the final package. The output ZIP contains the GeoPackage, dataset-level metadata tables, a package manifest, and attribution/license text.',
    source_repository_url = 'https://github.com/Deadwood-ai/prepackaged_datasets_dte',
    source_file_path = 'deadtrees_prepackaged/datasets/tree_cover_aerial_global.py'
where slug = 'tree-cover-aerial-global';

update public.prepackaged_dataset_definitions
set
    technical_description = 'Dataset-level eligibility starts from audited deadtrees.earth records that are public, CC BY licensed, not archived, and have a complete acquisition date. Standing-deadwood polygon eligibility is restricted to outputs that passed the export quality checks for deadwood. A conservative phenology filter is applied in Python using the exported phenology curve, requiring the acquisition-day indicator to be greater than 128. For each eligible dataset, AOI geometry is always retained in the package, while deadwood polygons are clipped to the AOI and reduced to polygonal geometries only. Datasets that end up with zero deadwood polygons after loading or clipping are still preserved in AOI and metadata outputs. The final ZIP contains one GeoPackage, dataset-level metadata tables, a package manifest, and attribution/license text.',
    source_repository_url = 'https://github.com/Deadwood-ai/prepackaged_datasets_dte',
    source_file_path = 'deadtrees_prepackaged/datasets/standing_deadwood_aerial_global_conservative.py'
where slug = 'standing-deadwood-aerial-global-conservative';

update public.prepackaged_dataset_definitions
set
    technical_description = 'Dataset eligibility starts from audited deadtrees.earth records that are public, CC BY licensed, not archived, have a complete acquisition date, include an orthophoto file, and have at least one AOI. For each eligible orthophoto, the raster is partitioned into non-overlapping 1024x1024 source windows, and only tiles whose full bounds are covered by the AOI are retained. A deterministic random sample seeded by dataset ID selects at most 20 tiles per dataset from those AOI-covered candidates. Selected tiles are written as GeoTIFF files under tiles/ in the original orthophoto CRS and native source resolution, and only the first three source bands (RGB) are read and saved. The package also includes dataset-level metadata tables, a per-tile index table, a package manifest, and attribution/license text inside the final ZIP archive.',
    source_repository_url = 'https://github.com/Deadwood-ai/prepackaged_datasets_dte',
    source_file_path = 'deadtrees_prepackaged/datasets/image_tiles_1024_global_aerial_sampled_20_random.py'
where slug = 'image-tiles-1024-global-aerial-sampled-20-random';

update public.prepackaged_dataset_versions
set
    source_commit = 'feffe7b73d2ec3159260a6d3fddf7e5ac9ae855a',
    source_package_version = '0.1.0'
where version = '2026.04.17'
  and definition_id in (
    select id
    from public.prepackaged_dataset_definitions
    where slug in (
        'tree-cover-aerial-global',
        'standing-deadwood-aerial-global-conservative',
        'image-tiles-1024-global-aerial-sampled-20-random'
    )
  );
